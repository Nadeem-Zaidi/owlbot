import { AgentRepository, AgentScheduleRow } from "../../repository/agent_repository";
import { AgentService } from "./agent_service";
import { computeNextRun } from "./schedule_time";
import { AgentRuntime } from "../../core/runtime";

const TICK_MS = 30_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_PARALLEL = 3;
const OUTPUT_PREVIEW_CHARS = 4000;

type Notifier = (userId: string, text: string) => Promise<boolean>;

// Runs agent schedules. Every 30s it picks due schedules, moves each one's
// next_run_at forward (so a slot can't run twice), then runs it: the task is
// sent to the agent in that schedule's own chat, the reply is saved there,
// and optionally sent to the user's WhatsApp.
export class AgentScheduler {
    private timer: NodeJS.Timeout | null = null;
    private running = new Set<string>();
    // When set, runs go through the shared runtime (queued behind any chat
    // turn in the same session); otherwise straight through AgentService.
    private runtime?: AgentRuntime;

    constructor(
        private repo: AgentRepository,
        private agents: AgentService,
        private notify?: Notifier,
    ) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), TICK_MS);
        this.timer.unref();
        void this.tick();
        console.log("[agents] scheduler started");
    }

    useRuntime(runtime: AgentRuntime): void {
        this.runtime = runtime;
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private async tick(): Promise<void> {
        try {
            const due = await this.repo.dueSchedules(10);
            for (const s of due) {
                if (this.running.size >= MAX_PARALLEL) break;
                if (this.running.has(s.id)) continue;
                const next = computeNextRun(s, new Date());
                if (!(await this.repo.claimSchedule(s.id, s.next_run_at!, next))) continue;
                void this.run(s, "schedule");
            }
        } catch (err) {
            console.error("[agents] scheduler tick failed:", err);
        }
    }

    /** "Run now" from the UI. Resolves once the run has started; returns its id. */
    async runNow(schedule: AgentScheduleRow): Promise<void> {
        if (this.running.has(schedule.id)) throw new Error("This schedule is already running");
        void this.run(schedule, "manual");
    }

    private async run(s: AgentScheduleRow, trigger: "schedule" | "manual"): Promise<void> {
        this.running.add(s.id);
        let runId: number | null = null;
        try {
            const agent = await this.repo.getAgent(s.agent_id, s.user_id);
            if (!agent) return;
            const sessionId = await this.agents.scheduleSession(s, agent);
            runId = await this.repo.startRun(agent.id, s.id, sessionId);
            await this.repo.setScheduleStatus(s.id, "running");

            const signal = AbortSignal.timeout(RUN_TIMEOUT_MS);
            const { text, error } = this.runtime
                ? await this.runtime.runToText({
                    channel: "schedule",
                    userId: s.user_id,
                    sessionId,
                    input: { type: "message", role: "user", content: [{ type: "text", text: s.prompt }] },
                }, signal).then((r) => ({
                    text: r.text.trim(),
                    error: r.error ?? (r.cancelled ? "The run took too long and was stopped." : null),
                }))
                : await this.agents.runOnce(agent, s.user_id, sessionId, s.prompt, signal);
            const ok = !!text && !error;
            await this.repo.finishRun(runId, ok ? "succeeded" : "failed", text.slice(0, OUTPUT_PREVIEW_CHARS) || null, error);
            await this.repo.setScheduleStatus(s.id, ok ? "succeeded" : "failed");
            console.log(`[agents] ${trigger} run of "${s.name}" (${agent.name}) ${ok ? "succeeded" : `failed: ${error}`}`);

            if (s.deliver_whatsapp && this.notify) {
                const body = ok ? text : `⚠️ The run failed: ${error ?? "no reply"}`;
                const sent = await this.notify(s.user_id, `⏰ *${agent.name}* — ${s.name}\n\n${body}`).catch(() => false);
                if (!sent) console.warn(`[agents] couldn't deliver "${s.name}" to WhatsApp (number not linked or bot offline)`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[agents] run of schedule ${s.id} failed:`, err);
            if (runId !== null) await this.repo.finishRun(runId, "failed", null, msg).catch(() => {});
            await this.repo.setScheduleStatus(s.id, "failed").catch(() => {});
        } finally {
            this.running.delete(s.id);
        }
    }
}
