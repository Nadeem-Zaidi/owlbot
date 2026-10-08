import { AgentRepository, AgentRow } from "../../repository/agent_repository";
import { PipelineInput, PipelineRepository, PipelineRunStep, PipelineStep } from "../../repository/pipeline_repository";
import { NativeAgentRow } from "../../repository/native_agent_repository";
import { MessageService } from "../message_service";
import { NativeAgentService } from "../native_agents/native_agent_service";
import { AgentError, AgentService } from "./agent_service";
import { FlowRunner, FlowRunnerDeps } from "../../core/flows/flow_runner";
import { FlowError, stepsToFlow, validateFlow } from "../../core/flows/flow_validate";
import { Flow, FlowRunState, FlowTraceEntry } from "../../core/flows/flow_types";

// Optional workflow features wired from main.ts (AI conditions, notifications).
export type FlowOptions = Pick<FlowRunnerDeps, "askModel" | "notify" | "webAppUrl">;

const MAX_STEPS = 10;
const STEP_TIMEOUT_MS = 5 * 60_000;
const MAX_INPUT_CHARS = 50_000;     // what one step may hand to the next
const MAX_PARALLEL_RUNS = 3;

const str = (v: unknown, max: number, field: string, required = false): string => {
    const s = typeof v === "string" ? v.trim() : "";
    if (required && !s) throw new AgentError(`${field} is required`);
    if (s.length > max) throw new AgentError(`${field} must be at most ${max} characters`);
    return s;
};

// Fills {{input}} / {{previous}}. If the instruction uses neither, the
// previous output is appended so the step always receives it.
export function renderInstruction(instruction: string, input: string, previous: string): string {
    const text = instruction.trim() || "{{previous}}";
    const usesPlaceholder = /\{\{\s*(input|previous)\s*\}\}/.test(text);
    const filled = text
        .replace(/\{\{\s*input\s*\}\}/g, input)
        .replace(/\{\{\s*previous\s*\}\}/g, previous);
    return usesPlaceholder ? filled : `${filled}\n\n---\nInput:\n${previous}`;
}

// Pipelines and workflows. A pipeline runs agents one after another (each
// step's output is the next step's input); a workflow (a pipeline with a
// `flow`) is a graph with conditions, approvals and notifications, run by
// FlowRunner. A step can be a regular agent or a provider agent.
export class PipelineService {
    private active = 0;
    private flows: FlowRunner;

    constructor(
        private repo: PipelineRepository,
        private agentRepo: AgentRepository,
        private agents: AgentService,
        private messageService: MessageService,
        private nativeAgents?: NativeAgentService,
        flowOptions: FlowOptions = {},
    ) {
        this.flows = new FlowRunner({ repo, agentRepo, agents, messageService, nativeAgents, ...flowOptions });
    }

    // The provider agent for a step, or null if it was deleted.
    private async nativeAgent(userId: string, id: string): Promise<NativeAgentRow | null> {
        if (!this.nativeAgents) return null;
        return this.nativeAgents.get(userId, id).catch(() => null);
    }

    async init(): Promise<void> {
        await this.repo.failInterruptedRuns();
    }

    async list(userId: string) {
        return this.repo.list(userId);
    }

    async get(userId: string, id: string) {
        const p = await this.repo.get(id, userId);
        if (!p) throw new AgentError("Pipeline not found", 404);
        // Older pipelines open in the workflow editor as a straight line.
        return { ...p, flow: p.flow ?? stepsToFlow(p.steps), is_workflow: !!p.flow, runs: await this.repo.listRuns(id, userId, 15) };
    }

    async create(userId: string, body: any) {
        return this.repo.create(userId, await this.validate(userId, body));
    }

    async update(userId: string, id: string, body: any) {
        if (!(await this.repo.get(id, userId))) throw new AgentError("Pipeline not found", 404);
        return (await this.repo.update(id, userId, await this.validate(userId, body)))!;
    }

    async remove(userId: string, id: string) {
        if (!(await this.repo.remove(id, userId))) throw new AgentError("Pipeline not found", 404);
    }

    async getRun(userId: string, runId: number) {
        const run = await this.repo.getRun(runId, userId);
        if (!run) throw new AgentError("Run not found", 404);
        return run;
    }

    private async validate(userId: string, b: any): Promise<PipelineInput> {
        const name = str(b?.name, 80, "Name", true);
        const description = str(b?.description, 300, "Description");
        if (b?.flow) {
            const flow = await validateFlow(b.flow, async (kind, id) =>
                kind === "native" ? !!(await this.nativeAgent(userId, id)) : !!(await this.agentRepo.getAgent(id, userId)),
            ).catch((err) => { throw err instanceof FlowError ? new AgentError(err.message, err.status) : err; });
            // `steps` lists the agent steps (for the gallery's "N steps").
            const steps = flow.nodes.flatMap((n) => (n.type === "agent" ? [{ kind: n.agent_kind, agent_id: n.agent_id, instruction: n.instruction }] : []));
            return { name, description, steps, flow };
        }
        const raw = Array.isArray(b?.steps) ? b.steps : [];
        if (raw.length === 0) throw new AgentError("Add at least one step");
        if (raw.length > MAX_STEPS) throw new AgentError(`A pipeline can have at most ${MAX_STEPS} steps`);
        const steps: PipelineStep[] = [];
        for (const [i, s] of raw.entries()) {
            const agentId = typeof s?.agent_id === "string" ? s.agent_id : "";
            const kind = s?.kind === "native" ? "native" : "agent";
            const exists = !!agentId && (kind === "native"
                ? !!(await this.nativeAgent(userId, agentId))
                : !!(await this.agentRepo.getAgent(agentId, userId)));
            if (!exists) throw new AgentError(`Step ${i + 1}: choose one of your agents`);
            steps.push({ kind, agent_id: agentId, instruction: str(s?.instruction, 4000, `Step ${i + 1} instruction`) });
        }
        return { name, description, steps };
    }

    /** Starts a run in the background and returns it immediately (status "running"). */
    async start(userId: string, pipelineId: string, rawInput: unknown) {
        const pipeline = await this.repo.get(pipelineId, userId);
        if (!pipeline) throw new AgentError("Pipeline not found", 404);
        if (this.active >= MAX_PARALLEL_RUNS) throw new AgentError("Too many pipelines are running — try again in a moment", 429);
        const input = str(rawInput, MAX_INPUT_CHARS, "Input");
        if (pipeline.flow) return this.startFlow(userId, pipeline.id, pipeline.name, pipeline.flow, input);

        const steps: PipelineRunStep[] = [];
        for (const [i, s] of pipeline.steps.entries()) {
            if (s.kind === "native") {
                const agent = await this.nativeAgent(userId, s.agent_id);
                // Fail before starting rather than halfway through the run.
                if (agent) {
                    await this.nativeAgents!.requireActive(userId, agent).catch((err) => {
                        throw new AgentError(`Step ${i + 1}: ${err.message}`, 409);
                    });
                }
                steps.push({ kind: "native", provider: agent?.provider, agent_id: s.agent_id, agent_name: agent?.name ?? "Deleted agent", agent_icon: agent?.icon ?? "❔", status: "pending" });
                continue;
            }
            const agent = await this.agentRepo.getAgent(s.agent_id, userId);
            steps.push({ kind: "agent", agent_id: s.agent_id, agent_name: agent?.name ?? "Deleted agent", agent_icon: agent?.icon ?? "❔", status: "pending" });
        }
        const run = await this.repo.startRun(pipelineId, userId, input, steps);
        this.active++;
        void this.execute(run.id, userId, pipeline.name, pipeline.steps, input, steps).finally(() => this.active--);
        return run;
    }

    // ── workflows ──
    private async startFlow(userId: string, pipelineId: string, name: string, flow: Flow, input: string) {
        // Provider agents must be usable before anything runs.
        for (const n of flow.nodes) {
            if (n.type !== "agent" || n.agent_kind !== "native") continue;
            const agent = await this.nativeAgent(userId, n.agent_id);
            if (agent) await this.nativeAgents!.requireActive(userId, agent).catch((err) => { throw new AgentError(`"${n.label ?? n.id}": ${err.message}`, 409); });
        }
        const state = this.flows.initialState(input, flow);
        const run = await this.repo.startRun(pipelineId, userId, input, [], state);
        this.runFlowInBackground(run.id, userId, pipelineId, name, flow, state, []);
        return run;
    }

    private runFlowInBackground(runId: number, userId: string, pipelineId: string, name: string, flow: Flow, state: FlowRunState, trace: FlowTraceEntry[]) {
        this.active++;
        void this.flows.run(runId, userId, pipelineId, name, flow, state, trace)
            .catch((err) => console.error(`[workflows] run ${runId} crashed:`, err))
            .finally(() => this.active--);
    }

    // Approve or reject a run waiting at an approval step. Works on any
    // server: the run is claimed atomically, then continues here.
    async decide(userId: string, runId: number, body: any) {
        if (typeof body?.approved !== "boolean") throw new AgentError("approved must be true or false");
        const comment = str(body?.comment, 500, "Comment");
        const run = await this.repo.claimWaiting(runId, userId);
        if (!run) throw new AgentError("This run isn't waiting for approval (already decided, or cancelled)", 409);
        const pipeline = await this.repo.get(run.pipeline_id, userId);
        const flow = pipeline?.flow;
        const state = run.state;
        const trace = (run.steps ?? []) as unknown as FlowTraceEntry[];
        const waitingAt = state?.current ? flow?.nodes.find((n) => n.id === state.current) : undefined;
        if (!pipeline || !flow || !state || waitingAt?.type !== "approval") {
            await this.repo.endRun(runId, "failed", trace, null, "The workflow was changed or deleted while waiting");
            throw new AgentError("The workflow was changed or deleted while waiting", 409);
        }
        const by = typeof body?.by === "string" ? body.by.slice(0, 120) : userId;
        const continues = this.flows.applyDecision(flow, state, trace, body.approved, by, comment);
        if (!continues) {
            await this.repo.endRun(runId, "rejected", trace, null, comment ? `Rejected: ${comment}` : "Rejected", state);
            return { status: "rejected" };
        }
        await this.repo.saveFlowRun(runId, trace, state);
        this.runFlowInBackground(runId, userId, pipeline.id, pipeline.name, flow, state, trace);
        return { status: "running" };
    }

    async cancel(userId: string, runId: number) {
        const run = await this.repo.cancelRun(runId, userId);
        if (!run) throw new AgentError("This run has already finished", 409);
        return { status: "cancelled" };
    }

    approvals(userId: string) {
        return this.repo.listWaiting(userId);
    }

    private async execute(runId: number, userId: string, pipelineName: string, plan: PipelineStep[], input: string, steps: PipelineRunStep[]) {
        let previous = input;
        try {
            for (let i = 0; i < plan.length; i++) {
                const step = steps[i];
                const native = plan[i].kind === "native";
                const agent = native ? await this.nativeAgent(userId, plan[i].agent_id) : await this.agentRepo.getAgent(plan[i].agent_id, userId);
                if (!agent) throw new Error(`Step ${i + 1}: the agent was deleted`);

                const prompt = renderInstruction(plan[i].instruction, input, previous);
                Object.assign(step, { status: "running", prompt: prompt.slice(0, 2000), started_at: new Date().toISOString() });
                await this.repo.saveRunSteps(runId, steps);

                // Each step gets its own hidden chat so agents don't see each other's history.
                const session = await this.messageService.createSession(userId, "pipeline", `🔗 ${pipelineName} · ${i + 1}. ${agent.name}`);
                const signal = AbortSignal.timeout(STEP_TIMEOUT_MS);
                const { text, error } = native
                    ? await this.nativeAgents!.runOnce(agent as NativeAgentRow, userId, session.id, prompt, signal)
                    : await this.agents.runOnce(agent as AgentRow, userId, session.id, prompt, signal);
                step.finished_at = new Date().toISOString();
                if (!text || error) {
                    Object.assign(step, { status: "failed", error: error ?? "The agent returned no output", output: text || undefined });
                    throw new Error(`Step ${i + 1} (${agent.name}) failed: ${step.error}`);
                }
                Object.assign(step, { status: "succeeded", output: text });
                await this.repo.saveRunSteps(runId, steps);
                previous = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) + "\n…[truncated]" : text;
            }
            await this.repo.finishRun(runId, "succeeded", steps, previous, null);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            for (const s of steps) if (s.status === "pending") s.status = "skipped";
            for (const s of steps) if (s.status === "running") Object.assign(s, { status: "failed", error: message, finished_at: new Date().toISOString() });
            await this.repo.finishRun(runId, "failed", steps, null, message).catch((e) => console.error("[pipelines] couldn't save failed run:", e));
            console.warn(`[pipelines] run ${runId} failed: ${message}`);
        }
    }
}
