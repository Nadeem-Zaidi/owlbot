import { createHash, randomBytes } from "node:crypto";
import { AgentRepository, AgentRow } from "../../repository/agent_repository";
import { StudioProjectRow, StudioRepository } from "../../repository/studio_repository";
import { AgentError, AgentService } from "../../service/agents/agent_service";
import { PipelineService } from "../../service/agents/pipeline_service";
import { computeNextRun, describeTiming } from "../../service/agents/schedule_time";
import { decryptSecret, encryptSecret } from "../../service/agents/secrets";
import { validateFlow, FlowError } from "../flows/flow_validate";
import { agentBody, attachments, compileFlow, parseCanvas, StudioError, syncFromAgents } from "./studio_canvas";
import { StudioCanvas, StudioNode, TriggerConfig } from "./studio_types";

const TICK_MS = 30_000;
const MAX_INPUT_CHARS = 50_000;

const text = (v: unknown, max: number, what: string, required = false) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (required && !s) throw new StudioError(`${what} is required`);
    if (s.length > max) throw new StudioError(`${what} must be at most ${max} characters`);
    return s;
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const asStudio = (err: unknown, prefix?: string) => {
    if (err instanceof StudioError) return err;
    if (err instanceof AgentError || err instanceof FlowError) return new StudioError(prefix ? `${prefix}: ${err.message}` : err.message, err.status);
    return err;
};

type AgentNode = Extract<StudioNode, { type: "agent" }>;

// Agent Studio. A project is a canvas of agents (with their model, tools,
// knowledge and skills plugged in) and flow steps, started by a trigger.
// Saving writes real agents and compiles the canvas into a hidden workflow
// (pipeline), so running, routers, conditions, approvals and run history
// are the Workflows engine's.
export class StudioService {
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private repo: StudioRepository,
        private agentRepo: AgentRepository,
        private agents: AgentService,
        private pipelines: PipelineService,
    ) {}

    // ── projects ──
    async list(userId: string) {
        const rows = await this.repo.list(userId);
        return rows.map((r) => ({
            ...this.summary(r),
            last_run_status: r.last_run_status,
            last_run_at: r.last_run_at,
        }));
    }

    async get(userId: string, id: string) {
        const row = await this.require(userId, id);
        const canvas = await this.liveCanvas(userId, row.canvas);
        const runs = row.pipeline_id ? (await this.pipelines.get(userId, row.pipeline_id).catch(() => null))?.runs ?? [] : [];
        return { ...this.summary(row), canvas, runs };
    }

    // Validates everything first, then writes agents, the workflow and the
    // project — so a mistake anywhere saves nothing.
    async save(userId: string, id: string | null, body: any) {
        const existing = id ? await this.require(userId, id) : null;
        const name = text(body?.name, 80, "Name", true);
        const description = text(body?.description, 300, "Description");
        const deliver = body?.deliver_result === true;
        const canvas = parseCanvas(body?.canvas, userId);
        const trigger = (canvas.nodes.find((n) => n.type === "trigger") as Extract<StudioNode, { type: "trigger" }>).trigger;
        if (trigger.type === "chat") {
            const owner = await this.repo.commandOwner(userId, trigger.command);
            if (owner && owner !== existing?.id) throw new StudioError(`/${trigger.command} already starts another project — pick another command`, 409);
        }

        // 1. Every agent's settings (with what's plugged into it) are valid.
        const agentNodes = canvas.nodes.filter((n): n is AgentNode => n.type === "agent");
        if (!agentNodes.length) throw new StudioError("Add at least one agent");
        const rows = new Map<string, AgentRow>();
        const bodies = new Map<string, ReturnType<typeof agentBody>>();
        for (const n of agentNodes) {
            const row = n.agent_id ? await this.agentRepo.getAgent(n.agent_id, userId) : null;
            if (n.agent_id && !row) n.agent_id = null;            // deleted meanwhile → create again
            if (row) rows.set(n.id, row);
            const b = agentBody(n.agent, attachments(canvas, n.id), row);
            await this.agents.checkInput(userId, b).catch((err) => { throw asStudio(err, `"${n.label || n.agent.name}"`); });
            bodies.set(n.id, b);
        }
        const names = agentNodes.map((n) => n.agent.name.toLowerCase());
        const dup = names.find((x, i) => names.indexOf(x) !== i);
        if (dup) throw new StudioError(`Two agents are called "${agentNodes.find((n) => n.agent.name.toLowerCase() === dup)!.agent.name}" — give each its own name`);

        // 2. The flow is valid (new agents stand in with placeholder ids).
        const placeholder = (nodeId: string) => canvas.nodes.find((n): n is AgentNode => n.id === nodeId && n.type === "agent")?.agent_id ?? `new-${nodeId}`;
        await this.checkFlow(userId, compileFlow(canvas, placeholder, deliver ? { projectName: name } : null));

        // 3. Write the agents (real ones, also on the Agents page).
        for (const n of agentNodes) {
            const b = bodies.get(n.id)!;
            if (n.agent_id) await this.agents.update(userId, n.agent_id, b);
            else n.agent_id = (await this.agents.create(userId, b)).id;
        }

        // 4. The workflow that runs it, then the project.
        const flow = compileFlow(canvas, (nodeId) => (canvas.nodes.find((n) => n.id === nodeId) as AgentNode).agent_id!, deliver ? { projectName: name } : null);
        const pipelineBody = { name, description, flow };
        let pipelineId = existing?.pipeline_id ?? null;
        let pipelineError: unknown = null;
        try {
            if (pipelineId && (await this.pipelines.get(userId, pipelineId).catch(() => null))) await this.pipelines.update(userId, pipelineId, pipelineBody);
            else pipelineId = (await this.pipelines.create(userId, pipelineBody)).id;
        } catch (err) {
            // Agents are already saved: keep their ids on the canvas, report the error.
            pipelineError = err;
        }

        const input = {
            name, description, canvas, pipeline_id: pipelineId,
            trigger_type: trigger.type,
            chat_command: trigger.type === "chat" ? trigger.command : null,
            deliver_result: deliver,
            next_run_at: trigger.type === "schedule" ? computeNextRun(trigger.timing, new Date()) : null,
        };
        const saved = existing ? (await this.repo.update(existing.id, userId, input))! : await this.repo.create(userId, input);
        if (trigger.type === "webhook" && !saved.webhook_hash) await this.issueWebhook(userId, saved.id);
        if (pipelineError) throw asStudio(pipelineError);
        return this.get(userId, saved.id);
    }

    async remove(userId: string, id: string) {
        const row = await this.repo.remove(id, userId);
        if (!row) throw new StudioError("Project not found", 404);
        if (row.pipeline_id) await this.pipelines.remove(userId, row.pipeline_id).catch(() => {});
        // The agents stay: they're regular agents, also used elsewhere.
        return { agents_kept: row.canvas.nodes.filter((n) => n.type === "agent" && n.agent_id).length };
    }

    // ── running ──
    async run(userId: string, id: string, rawInput: unknown) {
        const row = await this.require(userId, id);
        return this.startRun(row, rawInput);
    }

    private async startRun(row: StudioProjectRow, rawInput: unknown) {
        if (!row.pipeline_id) throw new StudioError("Save the project before running it", 409);
        const input = typeof rawInput === "string" ? rawInput.slice(0, MAX_INPUT_CHARS) : "";
        const run = await this.pipelines.start(row.user_id, row.pipeline_id, input).catch((err) => { throw asStudio(err); });
        await this.repo.touchTriggered(row.id).catch(() => {});
        return run;
    }

    // ── webhook trigger ──
    // A random token in the URL; only its hash is looked up, the encrypted
    // copy lets the owner see the URL again.
    private async issueWebhook(userId: string, id: string): Promise<string> {
        const token = `whk_${randomBytes(24).toString("base64url")}`;
        await this.repo.setWebhook(id, userId, sha256(token), encryptSecret(token));
        return token;
    }

    async rotateWebhook(userId: string, id: string) {
        const row = await this.require(userId, id);
        if (row.trigger_type !== "webhook") throw new StudioError("This project isn't started by a webhook", 409);
        await this.issueWebhook(userId, id);
        return this.get(userId, id);
    }

    async runFromWebhook(token: string, body: unknown) {
        if (!/^whk_[A-Za-z0-9_-]{20,64}$/.test(token)) throw new StudioError("Not found", 404);
        const row = await this.repo.byWebhook(sha256(token));
        if (!row) throw new StudioError("Not found", 404);
        // A text body, {"input": "…"}, or any JSON (passed on as JSON text).
        const input = typeof body === "string" ? body
            : body && typeof body === "object" && typeof (body as any).input === "string" && Object.keys(body).length === 1 ? (body as any).input
                : body && typeof body === "object" && Object.keys(body).length ? JSON.stringify(body, null, 2) : "";
        const run = await this.startRun(row, input);
        return { run_id: run.id, status: run.status };
    }

    // ── chat trigger ("/triage <text>" in WhatsApp / Telegram) ──
    commands(userId: string) {
        return this.repo.commands(userId);
    }

    async runCommand(userId: string, command: string, input: string): Promise<{ name: string; deliver: boolean } | null> {
        const row = await this.repo.byCommand(userId, command.toLowerCase());
        if (!row) return null;
        await this.startRun(row, input);
        return { name: row.name, deliver: row.deliver_result };
    }

    // ── schedule trigger ──
    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), TICK_MS);
        this.timer.unref();
        void this.tick();
        console.log("[studio] scheduler started");
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private async tick(): Promise<void> {
        try {
            for (const row of await this.repo.dueSchedules(10)) {
                const trigger = this.trigger(row.canvas);
                if (trigger.type !== "schedule") continue;
                // Claim the slot first (safe with several servers), then run.
                if (!(await this.repo.claimSchedule(row.id, row.next_run_at!, computeNextRun(trigger.timing, new Date())))) continue;
                await this.startRun(row, trigger.input).catch((err) => console.warn(`[studio] scheduled run of "${row.name}" didn't start: ${err?.message ?? err}`));
            }
        } catch (err) {
            console.error("[studio] scheduler tick failed:", err);
        }
    }

    // ── helpers ──
    private async require(userId: string, id: string): Promise<StudioProjectRow> {
        const row = await this.repo.get(id, userId);
        if (!row) throw new StudioError("Project not found", 404);
        return row;
    }

    private trigger(canvas: StudioCanvas): TriggerConfig {
        return (canvas.nodes.find((n) => n.type === "trigger") as Extract<StudioNode, { type: "trigger" }> | undefined)?.trigger ?? { type: "manual" };
    }

    private async checkFlow(userId: string, raw: unknown) {
        await validateFlow(raw, async (_kind, agentId) => agentId.startsWith("new-") || !!(await this.agentRepo.getAgent(agentId, userId)))
            .catch((err) => { throw asStudio(err); });
    }

    private async liveCanvas(userId: string, canvas: StudioCanvas): Promise<StudioCanvas> {
        const ids = canvas.nodes.flatMap((n) => (n.type === "agent" && n.agent_id ? [n.agent_id] : []));
        const rows = new Map<string, AgentRow>();
        for (const id of new Set(ids)) {
            const row = await this.agentRepo.getAgent(id, userId);
            if (row) rows.set(id, row);
        }
        return syncFromAgents(canvas, rows);
    }

    private webhookPath(r: StudioProjectRow): string | null {
        if (!r.webhook_secret) return null;
        try {
            return `/api/studio-hooks/${decryptSecret(r.webhook_secret)}`;
        } catch {
            return null;    // encryption key changed: "New URL" issues a fresh one
        }
    }

    private summary(r: StudioProjectRow) {
        const trigger = this.trigger(r.canvas);
        const agents = r.canvas.nodes.filter((n): n is AgentNode => n.type === "agent");
        return {
            id: r.id,
            name: r.name,
            description: r.description,
            pipeline_id: r.pipeline_id,
            trigger_type: r.trigger_type,
            trigger_summary: trigger.type === "schedule" ? describeTiming(trigger.timing)
                : trigger.type === "chat" ? `/${trigger.command} in WhatsApp or Telegram`
                    : trigger.type === "webhook" ? "Webhook" : "Run manually",
            chat_command: r.chat_command,
            deliver_result: r.deliver_result,
            webhook_path: r.trigger_type === "webhook" ? this.webhookPath(r) : null,
            next_run_at: r.next_run_at,
            last_triggered_at: r.last_triggered_at,
            agents: agents.map((a) => ({ name: a.agent.name, icon: a.agent.icon })),
            created_at: r.created_at,
            updated_at: r.updated_at,
        };
    }
}
