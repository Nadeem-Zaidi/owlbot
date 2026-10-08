import { randomUUID } from "node:crypto";
import { InvalidSession, SessionValidationError, ValidationError } from "../../error_handling/app_error";
import { ILLM } from "../../interfaces/illm";
import { LLMProvider } from "../../llms/llm_factory";
import { AgentService } from "../../service/agents/agent_service";
import { withAttachmentText } from "../../service/attachment_text";
import { KnowledgeBase } from "../../service/knowledge_base";
import { MessageService } from "../../service/message_service";
import { ModelRegistry } from "../../service/model_registry";
import { NativeAgentService } from "../../service/native_agents/native_agent_service";
import { LLMMessage } from "../../types/llm_message";
import { collectReply } from "./collect";
import { iterateInContext, logger, metrics } from "../../infra/observability";
import { EventBus } from "../../infra/events/event_bus";
import { isAbort, LaneFullError, LaneTimeoutError, SessionLanes } from "./session_lanes";
import { CollectedReply, RunChannel, RunRequest, RunTarget } from "./types";

export type AgentRuntimeDeps = {
    messageService: MessageService;
    providers: Map<LLMProvider, ILLM>;
    defaultProvider: LLMProvider;
    // Server providers + users' own keys (BYOK). Without it, only `providers`.
    registry?: ModelRegistry;
    agents?: AgentService;
    nativeAgents?: NativeAgentService;
    // Adds the extracted text of attached Word/Excel/… files to the input.
    kb?: KnowledgeBase;
    lanes?: SessionLanes;
    // Only the OpenAI provider reads it (raw fetch calls).
    apiKey?: string;
    // Live events to the web app (run started/finished → the sidebar updates).
    events?: EventBus;
};

// A resolved turn, ready to stream. `prepare()` does everything that can be
// rejected up front (bad session, unknown model, missing agent) so HTTP
// callers can still answer 400/404 before streaming starts.
export type PreparedRun = {
    readonly runId: string;
    readonly target: RunTarget;
    readonly input: LLMMessage;
    // The turn's events (the providers' chunks, unchanged). Waits for the
    // session's lane first; a turn queued behind another starts when it ends.
    stream(signal: AbortSignal): AsyncGenerator<LLMMessage, void, unknown>;
};

// A turn that can't run, reported to the user rather than thrown (e.g. a
// provider-native agent whose provider is switched off).
export type BlockedRun = { blocked: string };

// The single place a user turn is run, whatever the channel: it checks the
// session, resolves the agent and model, serializes turns per session, runs
// the provider and logs one line per turn. Routes and channel bridges only
// translate their input into a RunRequest and the events back into their
// own format.
export class AgentRuntime {
    readonly lanes: SessionLanes;
    private active = new Map<string, { channel: RunChannel; sessionId: string; startedAt: number }>();

    constructor(private deps: AgentRuntimeDeps) {
        this.lanes = deps.lanes ?? defaultLanes;
    }

    // Turns running right now in this process (for health/metrics and shutdown).
    activeRuns(): number {
        return this.active.size;
    }

    async prepare(req: RunRequest): Promise<PreparedRun | BlockedRun> {
        if (!req.sessionId) throw new InvalidSession();
        // Never read or append to another user's conversation.
        if (!(await this.deps.messageService.isSessionValid(String(req.sessionId), req.userId))) {
            throw new SessionValidationError();
        }
        const input = this.deps.kb && req.input ? await withAttachmentText(req.input, req.userId, this.deps.kb) : req.input;
        const target = await this.resolveTarget(req);
        if ("blocked" in target) return target;
        const runId = randomUUID();
        return {
            runId,
            target,
            input,
            stream: (signal) => this.stream(runId, req, target, input, signal),
        };
    }

    // Runs a turn and returns the whole reply (WhatsApp, schedules).
    // Problems come back in `error` instead of being thrown.
    async runToText(req: RunRequest, signal: AbortSignal): Promise<CollectedReply> {
        try {
            const prepared = await this.prepare(req);
            if ("blocked" in prepared) return { text: "", sources: [], error: prepared.blocked, cancelled: false };
            return await collectReply(prepared.stream(signal));
        } catch (err) {
            return { text: "", sources: [], error: err instanceof Error ? err.message : String(err), cancelled: false };
        }
    }

    // ── target resolution ──
    // Precedence: a provider-native agent the chat belongs to, then one of
    // this server's agents, then the plain chat model the caller picked.
    private async resolveTarget(req: RunRequest): Promise<RunTarget | BlockedRun> {
        const userId = req.userId;
        const sessionId = String(req.sessionId);

        if (this.deps.nativeAgents) {
            const requested = typeof req.nativeAgentId === "string" ? req.nativeAgentId : undefined;
            const native = await this.deps.nativeAgents.agentForSession(sessionId, userId, requested).catch((err) => {
                if (err?.status === 409) return { blocked: String(err.message) } as BlockedRun;
                throw err;
            });
            if (native && "blocked" in native) return native;
            if (native) {
                // Approval prompts need someone watching the web app.
                const interactive = req.channel === "web";
                return {
                    kind: "native",
                    llm: this.deps.nativeAgents.llmFor(native.agent, native.remoteSessionId, interactive),
                    model: native.agent.model,
                    agentId: native.agent.id,
                };
            }
        }

        if (this.deps.agents) {
            const agent = await this.deps.agents.agentForSession(sessionId, userId, req.agentId);
            if (agent) {
                const { llm, model } = await this.deps.agents.resolveLLM(agent);
                return { kind: "agent", llm, model, run: await this.deps.agents.buildRun(agent), agentId: agent.id };
            }
        }

        const { llm, model } = await this.resolveChatModel(req);
        return { kind: "chat", llm, model };
    }

    // Only models configured for the server, or on the user's own key — a
    // client can't pick an arbitrary (possibly expensive) model.
    private async resolveChatModel(req: RunRequest): Promise<{ llm: ILLM; model: string }> {
        const provider = req.provider ?? undefined;
        const model = req.model ?? undefined;
        if (this.deps.registry) {
            const r = await this.deps.registry.resolve(req.userId, provider, model, !!req.strictModel).catch((err) => {
                throw new ValidationError(err instanceof Error ? err.message : String(err));
            });
            return { llm: r.llm, model: r.model };
        }
        const { providers, defaultProvider } = this.deps;
        if (req.strictModel) {
            const found = providers.get((provider ?? defaultProvider) as LLMProvider);
            if (!found) throw new ValidationError(`LLM provider "${provider}" is not available`);
            if (model && !(found.getModels?.() ?? [found.getModel()]).includes(model)) {
                throw new ValidationError(`Model "${model}" is not available for ${found.getProvider()}`);
            }
            return { llm: found, model: model ?? found.getModel() };
        }
        const chosen = provider && providers.has(provider as LLMProvider) ? (provider as LLMProvider) : defaultProvider;
        const llm = providers.get(chosen)!;
        const models = llm.getModels?.() ?? [llm.getModel()];
        return { llm, model: model && models.includes(model) ? model : llm.getModel() };
    }

    // ── running ──
    private async *stream(runId: string, req: RunRequest, target: RunTarget, input: LLMMessage, signal: AbortSignal): AsyncGenerator<LLMMessage, void, unknown> {
        const queuedAt = Date.now();
        let release: (() => void) | null = null;
        try {
            release = await this.lanes.acquire(req.sessionId, signal, (ahead) =>
                console.log(`[runtime] run ${short(runId)} queued behind ${ahead} turn(s) in session ${short(req.sessionId)}`));
        } catch (err) {
            if (isAbort(err)) return; // the user left while it was waiting
            if (err instanceof LaneFullError || err instanceof LaneTimeoutError) {
                metrics.laneRejected.inc({ reason: err instanceof LaneFullError ? "full" : "timeout" });
                yield { type: "error", message: err.message } as LLMMessage;
                return;
            }
            throw err;
        }
        metrics.laneWait.observe((Date.now() - queuedAt) / 1000, { channel: req.channel });

        const startedAt = Date.now();
        const waitedMs = startedAt - queuedAt;
        this.active.set(runId, { channel: req.channel, sessionId: req.sessionId, startedAt });
        this.deps.events?.publish(req.userId, { type: "run.started", sessionId: req.sessionId, runId, channel: req.channel });
        let status: "done" | "error" | "cancelled" = "done";
        try {
            // Provider and tool log lines during the turn carry its run id.
            const turn = target.llm.chatStream([input], req.userId, req.sessionId, this.deps.apiKey ?? "", signal, target.model, target.run);
            for await (const chunk of iterateInContext({ runId, sessionId: req.sessionId, channel: req.channel }, turn)) {
                const type = (chunk as any).type;
                if (type === "error") {
                    status = "error";
                    metrics.llmErrors.inc({ provider: target.llm.getProvider(), code: String((chunk as any).code ?? "error").slice(0, 40) });
                } else if (type === "cancelled") status = "cancelled";
                yield chunk;
            }
            if (signal.aborted && status === "done") status = "cancelled";
        } catch (err) {
            status = "error";
            throw err;
        } finally {
            this.active.delete(runId);
            release?.();
            // One line per turn; ids only, never message content.
            const ms = Date.now() - startedAt;
            this.deps.events?.publish(req.userId, { type: "run.finished", sessionId: req.sessionId, runId, channel: req.channel, status });
            metrics.turns.inc({ channel: req.channel, target: target.kind, status });
            metrics.turnDuration.observe(ms / 1000, { channel: req.channel, target: target.kind });
            logger.info({
                runId, sessionId: req.sessionId, userId: req.userId, channel: req.channel, target: target.kind,
                agentId: target.kind === "chat" ? undefined : target.agentId, model: target.model, status, ms, waitedMs: waitedMs > 50 ? waitedMs : undefined,
            }, `turn ${status}`);
        }
    }
}

// Shared by every runtime in the process, so turns for one session queue up
// together even when two components each build their own runtime.
const defaultLanes = new SessionLanes();

const short = (id: string) => id.slice(0, 8);
