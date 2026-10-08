import { AgentRepository, AgentRow } from "../../repository/agent_repository";
import { NativeAgentRow } from "../../repository/native_agent_repository";
import { PipelineRepository } from "../../repository/pipeline_repository";
import { AgentService } from "../../service/agents/agent_service";
import { MessageService } from "../../service/message_service";
import { NativeAgentService } from "../../service/native_agents/native_agent_service";
import { metrics } from "../../infra/observability";
import { conditionSource, evaluateRule, parseYesNo, renderTemplate } from "./flow_rules";
import { Branch, Flow, FlowNode, FlowRunState, FlowTraceEntry } from "./flow_types";

const STEP_TIMEOUT_MS = 5 * 60_000;
const MAX_TEXT_CHARS = 50_000;     // what one step may hand to the next
const MAX_NODES_PER_RUN = 60;      // safety net (flows are loop-free anyway)

export type FlowRunnerDeps = {
    repo: PipelineRepository;
    agentRepo: AgentRepository;
    agents: AgentService;
    messageService: MessageService;
    nativeAgents?: NativeAgentService;
    // One plain model turn in a hidden chat (AI conditions).
    askModel?: (userId: string, sessionId: string, prompt: string, signal: AbortSignal) => Promise<{ text: string; error: string | null }>;
    // A message to the user's linked WhatsApp / Telegram. False if not linked.
    notify?: (userId: string, text: string) => Promise<boolean>;
    webAppUrl?: string;
};

const clip = (s: string) => (s.length > MAX_TEXT_CHARS ? `${s.slice(0, MAX_TEXT_CHARS)}\n…[truncated]` : s);
const now = () => new Date().toISOString();

export class FlowStop extends Error {}

// Runs a workflow graph from a node until it ends or pauses at an approval.
// State is saved after every step, so a paused run can continue later —
// from any server — and a crash leaves an accurate trace.
export class FlowRunner {
    constructor(private deps: FlowRunnerDeps) {}

    initialState(input: string, flow: Flow): FlowRunState {
        const start = flow.nodes.find((n) => n.type === "start")!;
        return { current: start.id, input, previous: input, outputs: {}, executed: 0, touched_at: now() };
    }

    // Continues the run from state.current. Returns how it ended.
    async run(runId: number, userId: string, pipelineId: string, pipelineName: string, flow: Flow, state: FlowRunState, trace: FlowTraceEntry[]): Promise<"succeeded" | "waiting" | "failed" | "rejected" | "cancelled"> {
        const byId = new Map(flow.nodes.map((n) => [n.id, n]));
        const next = (from: string, branch?: Branch) => flow.edges.find((e) => e.from === from && (branch ? e.branch === branch : !e.branch))?.to ?? null;
        const save = async () => {
            state.touched_at = now();
            await this.deps.repo.saveFlowRun(runId, trace, state);
        };

        try {
            while (state.current) {
                // Cancelled from the web app (possibly on another server).
                if ((await this.deps.repo.getRunStatus(runId)) === "cancelled") return "cancelled";
                if (++state.executed > MAX_NODES_PER_RUN) throw new FlowStop("The workflow ran too many steps");
                const node = byId.get(state.current);
                if (!node) throw new FlowStop(`Step "${state.current}" no longer exists`);
                const entry: FlowTraceEntry = { node_id: node.id, type: node.type, label: node.label ?? defaultLabel(node), status: "running", started_at: now() };
                trace.push(entry);

                switch (node.type) {
                    case "start":
                        Object.assign(entry, { status: "succeeded", output: clip(state.input), finished_at: now() });
                        state.outputs[node.id] = state.input;
                        state.current = next(node.id);
                        break;

                    case "agent": {
                        const native = node.agent_kind === "native";
                        const agent = native
                            ? await this.deps.nativeAgents?.get(userId, node.agent_id).catch(() => null)
                            : await this.deps.agentRepo.getAgent(node.agent_id, userId);
                        if (!agent) throw new FlowStop(`"${entry.label}": the agent was deleted`);
                        const prompt = renderInstruction(node.instruction, state);
                        Object.assign(entry, { kind: node.agent_kind, agent_id: agent.id, agent_name: agent.name, agent_icon: agent.icon, prompt: prompt.slice(0, 2000) });
                        await save();
                        // Each step gets its own hidden chat, so agents don't see each other's history.
                        const session = await this.deps.messageService.createSession(userId, "pipeline", `🔀 ${pipelineName} · ${entry.label}`);
                        const signal = AbortSignal.timeout(STEP_TIMEOUT_MS);
                        const { text, error } = native
                            ? await this.deps.nativeAgents!.runOnce(agent as NativeAgentRow, userId, session.id, prompt, signal)
                            : await this.deps.agents.runOnce(agent as AgentRow, userId, session.id, prompt, signal);
                        entry.finished_at = now();
                        if (!text || error) {
                            Object.assign(entry, { status: "failed", error: error ?? "The agent returned no output", output: text || undefined });
                            throw new FlowStop(`"${entry.label}" failed: ${entry.error}`);
                        }
                        Object.assign(entry, { status: "succeeded", output: text });
                        state.outputs[node.id] = clip(text);
                        state.previous = clip(text);
                        state.current = next(node.id);
                        break;
                    }

                    case "condition": {
                        const subject = conditionSource(node.source, state.input, state.previous, state.outputs);
                        let result: boolean;
                        let detail: string;
                        if (node.mode === "rule") {
                            ({ result, detail } = evaluateRule(subject, node.op, node.value));
                        } else {
                            if (!this.deps.askModel) throw new FlowStop("AI conditions aren't available on this server");
                            await save();
                            const session = await this.deps.messageService.createSession(userId, "pipeline", `🔀 ${pipelineName} · ${entry.label}`);
                            const prompt = `Answer with only YES or NO.\n\nQuestion: ${renderTemplate(node.question, state.input, state.previous, state.outputs)}\n\nText:\n${subject.slice(0, 20_000)}`;
                            const r = await this.deps.askModel(userId, session.id, prompt, AbortSignal.timeout(STEP_TIMEOUT_MS));
                            const yes = r.error ? null : parseYesNo(r.text);
                            if (yes === null) throw new FlowStop(`"${entry.label}": the AI didn't answer yes or no${r.error ? ` (${r.error})` : ""}`);
                            result = yes;
                            detail = `AI answered ${yes ? "YES" : "NO"}`;
                        }
                        const branch: Branch = result ? "true" : "false";
                        Object.assign(entry, { status: "succeeded", branch, output: `${result ? "Yes" : "No"} — ${detail}`, finished_at: now() });
                        state.current = next(node.id, branch);
                        break;
                    }

                    case "approval": {
                        const message = renderTemplate(node.message, state.input, state.previous, state.outputs);
                        Object.assign(entry, { status: "waiting", output: clip(message) });
                        // Pause here; decide() continues the run.
                        state.current = node.id;
                        state.touched_at = now();
                        await this.deps.repo.pauseRun(runId, trace, state);
                        if (node.notify && this.deps.notify) {
                            const link = this.deps.webAppUrl ? `\n\nOpen: ${this.deps.webAppUrl.replace(/\/+$/, "")}/pipelines/${pipelineId}` : "";
                            await this.deps.notify(userId, `⏸️ **${pipelineName}** is waiting for your approval:\n\n${message.slice(0, 1500)}${link}`).catch(() => false);
                        }
                        metrics.flowNodes.inc({ type: "approval", outcome: "waiting" });
                        return "waiting";
                    }

                    case "notify": {
                        const message = renderTemplate(node.message, state.input, state.previous, state.outputs);
                        const sent = this.deps.notify ? await this.deps.notify(userId, message).catch(() => false) : false;
                        Object.assign(entry, { status: "succeeded", output: sent ? "Sent" : "Not sent — link WhatsApp or Telegram to receive messages", finished_at: now() });
                        state.current = next(node.id);
                        break;
                    }

                    case "end": {
                        const output = renderTemplate(node.output, state.input, state.previous, state.outputs).trim() || state.previous;
                        Object.assign(entry, { status: "succeeded", output: clip(output), finished_at: now() });
                        state.current = null;
                        metrics.flowNodes.inc({ type: "end", outcome: "succeeded" });
                        await this.deps.repo.endRun(runId, "succeeded", trace, clip(output), null, state);
                        return "succeeded";
                    }
                }
                metrics.flowNodes.inc({ type: node.type, outcome: "succeeded" });
                await save();
            }
            throw new FlowStop("The workflow stopped without reaching an End step");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const last = trace[trace.length - 1];
            if (last?.status === "running") Object.assign(last, { status: "failed", error: message, finished_at: now() });
            metrics.flowNodes.inc({ type: last?.type ?? "unknown", outcome: "failed" });
            await this.deps.repo.endRun(runId, "failed", trace, null, message, state).catch((e) => console.error("[workflows] couldn't save a failed run:", e));
            console.warn(`[workflows] run ${runId} failed: ${message}`);
            return "failed";
        }
    }

    // Records an approval decision on a run that was claimed (status →
    // running) and moves state.current to the chosen branch. Returns false
    // when "rejected" has nowhere to go (the run ends as rejected).
    applyDecision(flow: Flow, state: FlowRunState, trace: FlowTraceEntry[], approved: boolean, by: string, comment?: string): boolean {
        const nodeId = state.current;
        const entry = [...trace].reverse().find((t) => t.node_id === nodeId && t.status === "waiting");
        const branch: Branch = approved ? "approved" : "rejected";
        if (entry) Object.assign(entry, { status: approved ? "succeeded" : "rejected", branch, decided_by: by, comment: comment || undefined, finished_at: now() });
        const to = flow.edges.find((e) => e.from === nodeId && e.branch === branch)?.to ?? null;
        state.current = to;
        state.touched_at = now();
        return !!to;
    }
}

// Fills the templates; with no placeholder at all, the previous output is
// appended so an agent always receives it (same rule as pipelines).
function renderInstruction(instruction: string, state: FlowRunState): string {
    const text = instruction.trim() || "{{previous}}";
    const filled = renderTemplate(text, state.input, state.previous, state.outputs);
    return /\{\{\s*(input|previous|node\.[A-Za-z0-9_-]+)\s*\}\}/.test(text) ? filled : `${filled}\n\n---\nInput:\n${state.previous}`;
}

function defaultLabel(n: FlowNode): string {
    return { start: "Start", agent: "Agent", condition: "Condition", approval: "Approval", notify: "Notify", end: "End" }[n.type];
}
