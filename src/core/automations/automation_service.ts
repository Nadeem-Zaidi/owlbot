import { AutomationRepository, TaskInput, TaskRow, WatcherInput, WatcherRow } from "../../repository/automation_repository";
import { assertPublicUrl } from "../../service/agents/url_guard";
import { parseYesNo } from "../flows/flow_rules";
import { dayOfMonth, formatLocal, isValidTimezone, localIso, nextAfter, parseLocal, Repeat, REPEAT_LABEL, REPEATS } from "./automation_time";
import { diffLines, fetchPageText, hashText, PageError } from "./web_page";

const TICK_MS = 30_000;
const MAX_OPEN_TASKS = 200;
const MAX_WATCHERS = 20;
const MIN_INTERVAL = 30;            // minutes between checks of one page
const MAX_INTERVAL = 7 * 24 * 60;
const PAUSE_AFTER_FAILURES = 5;
const MAX_PARALLEL_CHECKS = 3;
const AI_PAGE_CHARS = 20_000;

const LEGACY_ZONES: Record<string, string> = {
    "Asia/Calcutta": "Asia/Kolkata", "Asia/Saigon": "Asia/Ho_Chi_Minh", "Asia/Katmandu": "Asia/Kathmandu",
    "Asia/Rangoon": "Asia/Yangon", "Europe/Kiev": "Europe/Kyiv", "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
};

export class AutomationError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

export type AutomationDeps = {
    repo: AutomationRepository;
    // A message to the user's linked WhatsApp / Telegram; false if none.
    notify?: (userId: string, text: string) => Promise<boolean>;
    // One plain model answer for the user (AI watchers); billed to them.
    askModel?: (userId: string, prompt: string, signal: AbortSignal) => Promise<{ text: string; error: string | null }>;
    defaultTimezone?: string;
};

const text = (v: unknown, max: number, what: string, required = false) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (required && !s) throw new AutomationError(`${what} is required`);
    if (s.length > max) throw new AutomationError(`${what} must be at most ${max} characters`);
    return s;
};

// Reminders and to-dos, web watchers, and the alerts they send.
export class AutomationService {
    private timer: NodeJS.Timeout | null = null;
    private checking = new Set<string>();

    constructor(private deps: AutomationDeps) {}

    // ── timezone ──
    async timezone(userId: string): Promise<string> {
        return (await this.deps.repo.timezone(userId)) ?? this.deps.defaultTimezone ?? "UTC";
    }

    async setTimezone(userId: string, tz: unknown): Promise<string> {
        const raw = text(tz, 60, "Timezone", true);
        // Browsers still report some old names; store the current one.
        const value = LEGACY_ZONES[raw] ?? raw;
        if (!isValidTimezone(value)) throw new AutomationError(`Unknown timezone "${value}" — use a name like Asia/Kolkata`);
        await this.deps.repo.setTimezone(userId, value);
        return value;
    }

    async settings(userId: string) {
        const tz = await this.timezone(userId);
        return { timezone: tz, saved: !!(await this.deps.repo.timezone(userId)), now_local: localIso(new Date(), tz) };
    }

    // ── tasks ──
    async listTasks(userId: string, status: "open" | "all" = "open") {
        return (await this.deps.repo.listTasks(userId, status)).map(taskDto);
    }

    // A time from "remind_at" (local wall time) or "in_minutes".
    private async resolveTime(userId: string, b: any): Promise<{ at: Date | null; tz: string }> {
        const tz = b?.timezone ? text(b.timezone, 60, "Timezone") : await this.timezone(userId);
        if (!isValidTimezone(tz)) throw new AutomationError(`Unknown timezone "${tz}"`);
        if (b?.in_minutes !== undefined && b?.in_minutes !== null && b?.in_minutes !== "") {
            const m = Number(b.in_minutes);
            if (!Number.isFinite(m) || m < 1 || m > 525_600) throw new AutomationError("in_minutes must be between 1 and 525600");
            return { at: new Date(Date.now() + Math.round(m) * 60_000), tz };
        }
        if (typeof b?.remind_at === "string" && b.remind_at.trim()) {
            const at = parseLocal(b.remind_at, tz);
            if (!at) throw new AutomationError(`"${b.remind_at}" isn't a valid time — use YYYY-MM-DDTHH:MM`);
            if (at.getTime() < Date.now() - 60_000) {
                throw new AutomationError(`That time has already passed — it's now ${formatLocal(new Date(), tz)} (${tz})`);
            }
            return { at, tz };
        }
        return { at: null, tz };
    }

    private async taskInput(userId: string, b: any): Promise<TaskInput> {
        const title = text(b?.title, 300, "Title", true);
        const notes = text(b?.notes, 2000, "Notes");
        const repeat = (b?.repeat ?? "none") as Repeat;
        if (!REPEATS.includes(repeat)) throw new AutomationError(`repeat must be one of ${REPEATS.join(", ")}`);
        const { at, tz } = await this.resolveTime(userId, b);
        if (repeat !== "none" && !at) throw new AutomationError("A repeating reminder needs a first time");
        return { title, notes, remind_at: at, repeat, timezone: tz, anchor_day: at && (repeat === "monthly" || repeat === "yearly") ? dayOfMonth(at, tz) : null };
    }

    async createTask(userId: string, body: any, source: "web" | "chat" = "web") {
        if ((await this.deps.repo.countOpenTasks(userId)) >= MAX_OPEN_TASKS) throw new AutomationError(`You have ${MAX_OPEN_TASKS} open tasks — complete or delete some first`, 409);
        return taskDto(await this.deps.repo.createTask(userId, await this.taskInput(userId, body), source));
    }

    async updateTask(userId: string, id: string, body: any) {
        const t = await this.deps.repo.updateTask(id, userId, await this.taskInput(userId, body));
        if (!t) throw new AutomationError("Task not found", 404);
        return taskDto(t);
    }

    async setTaskStatus(userId: string, id: string, status: unknown) {
        if (status !== "open" && status !== "done" && status !== "cancelled") throw new AutomationError("status must be open, done or cancelled");
        const t = await this.deps.repo.setTaskStatus(id, userId, status);
        if (!t) throw new AutomationError("Task not found", 404);
        return taskDto(t);
    }

    async deleteTask(userId: string, id: string) {
        if (!(await this.deps.repo.deleteTask(id, userId))) throw new AutomationError("Task not found", 404);
    }

    // For chat tools: an id or its first characters → exactly one task.
    async findTask(userId: string, idOrPrefix: unknown): Promise<TaskRow> {
        const key = text(idOrPrefix, 64, "id", true);
        const found = key.length >= 4 ? await this.deps.repo.findTask(userId, key) : [];
        if (found.length !== 1) throw new AutomationError(found.length ? "That id matches several tasks — use more characters" : "No task with that id — call list_tasks to see them");
        return found[0];
    }

    // ── watchers ──
    async listWatchers(userId: string) {
        return (await this.deps.repo.listWatchers(userId)).map(watcherDto);
    }

    private async watcherInput(b: any): Promise<WatcherInput> {
        const url = text(b?.url, 2000, "URL", true);
        const parsed = await assertPublicUrl(url).catch((e) => { throw new AutomationError(e.message); });
        const condition = text(b?.condition, 500, "Condition");
        const mode = b?.mode === "ai" || (b?.mode === undefined && condition) ? "ai" : "change";
        if (mode === "ai" && !condition) throw new AutomationError("Describe what to look for, e.g. “the price is below ₹50,000”");
        const interval = Math.round(Number(b?.interval_minutes ?? 360));
        if (!Number.isFinite(interval) || interval < MIN_INTERVAL || interval > MAX_INTERVAL) {
            throw new AutomationError(`Check every ${MIN_INTERVAL} minutes to 7 days`);
        }
        return { name: text(b?.name, 80, "Name") || parsed.hostname.replace(/^www\./, ""), url: parsed.toString(), mode, condition: mode === "ai" ? condition : "", interval_minutes: interval };
    }

    async createWatcher(userId: string, body: any) {
        if ((await this.deps.repo.countWatchers(userId)) >= MAX_WATCHERS) throw new AutomationError(`You can watch up to ${MAX_WATCHERS} pages`, 409);
        return watcherDto(await this.deps.repo.createWatcher(userId, await this.watcherInput(body)));
    }

    async updateWatcher(userId: string, id: string, body: any) {
        const before = await this.deps.repo.getWatcher(id, userId);
        if (!before) throw new AutomationError("Watcher not found", 404);
        const input = await this.watcherInput(body);
        const reset = input.url !== before.url || input.mode !== before.mode || input.condition !== before.condition;
        return watcherDto((await this.deps.repo.updateWatcher(id, userId, input, reset))!);
    }

    async setWatcherStatus(userId: string, id: string, status: unknown) {
        if (status !== "active" && status !== "paused") throw new AutomationError("status must be active or paused");
        const w = await this.deps.repo.setWatcherStatus(id, userId, status);
        if (!w) throw new AutomationError("Watcher not found", 404);
        return watcherDto(w);
    }

    async deleteWatcher(userId: string, id: string) {
        if (!(await this.deps.repo.deleteWatcher(id, userId))) throw new AutomationError("Watcher not found", 404);
    }

    async findWatcher(userId: string, idOrPrefix: unknown): Promise<WatcherRow> {
        const key = text(idOrPrefix, 64, "id", true);
        const found = key.length >= 4 ? await this.deps.repo.findWatcher(userId, key) : [];
        if (found.length !== 1) throw new AutomationError(found.length ? "That id matches several watchers — use more characters" : "No watcher with that id — call list_watchers to see them");
        return found[0];
    }

    // "Check now" from the web app.
    async checkNow(userId: string, id: string) {
        const w = await this.deps.repo.getWatcher(id, userId);
        if (!w) throw new AutomationError("Watcher not found", 404);
        if (this.checking.has(w.id)) throw new AutomationError("It's being checked right now", 409);
        await this.check(w);
        return watcherDto((await this.deps.repo.getWatcher(id, userId))!);
    }

    // ── alerts inbox ──
    async alerts(userId: string) {
        const [list, unread] = await Promise.all([this.deps.repo.listAlerts(userId, 100), this.deps.repo.unreadAlerts(userId)]);
        return { alerts: list, unread };
    }

    unread(userId: string) {
        return this.deps.repo.unreadAlerts(userId);
    }

    markRead(userId: string) {
        return this.deps.repo.markAlertsRead(userId);
    }

    // ── scheduler (jobs server) ──
    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), TICK_MS);
        this.timer.unref();
        void this.tick();
        console.log("[automations] scheduler started");
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async tick(): Promise<void> {
        try {
            for (const t of await this.deps.repo.claimDueTasks(25)) {
                await this.sendReminder(t).catch((e) => console.error(`[automations] reminder ${t.id} failed:`, e));
            }
            const free = MAX_PARALLEL_CHECKS - this.checking.size;
            if (free > 0) {
                const due = await this.deps.repo.claimDueWatchers(free);
                await Promise.all(due.map((w) => this.check(w).catch((e) => console.error(`[automations] watcher ${w.id} failed:`, e))));
            }
        } catch (err) {
            console.error("[automations] tick failed:", err);
        }
    }

    private async deliver(userId: string, kind: "reminder" | "watcher", refId: string, title: string, body: string, message: string) {
        const sent = this.deps.notify ? await this.deps.notify(userId, message).catch(() => false) : false;
        await this.deps.repo.addAlert(userId, { kind, refId, title, body, via: sent ? "phone" : "app" });
    }

    private async sendReminder(t: TaskRow & { due_at: Date }) {
        const repeatNote = t.repeat !== "none" ? `\n_(${REPEAT_LABEL[t.repeat]})_` : "";
        await this.deliver(t.user_id, "reminder", t.id, t.title, t.notes, `⏰ **Reminder:** ${t.title}${t.notes ? `\n${t.notes}` : ""}${repeatNote}`);
        await this.deps.repo.afterReminder(t.id, nextAfter(t.due_at, t.repeat, t.timezone, t.anchor_day, new Date()));
    }

    // One check of a page. Change mode compares the page's lines with last
    // time; AI mode asks the model whether the condition holds and alerts
    // when it becomes true (not on every check while it stays true).
    async check(w: WatcherRow): Promise<void> {
        this.checking.add(w.id);
        try {
            let page: { url: string; text: string };
            try {
                page = await fetchPageText(w.url);
            } catch (e) {
                return await this.failed(w, e instanceof PageError ? e.message : "The page couldn't be read");
            }
            if (!page.text.trim()) return await this.failed(w, "The page has no readable text (it may need JavaScript)");
            const hash = hashText(page.text);

            if (w.mode === "change") {
                if (!w.last_hash) {
                    return await this.deps.repo.saveCheck(w.id, { hash, text: page.text, match: null, result: "Started watching — you'll hear when it changes.", alerted: false, error: null, failCount: 0, pause: false });
                }
                const { added, removed } = w.last_hash === hash ? { added: [], removed: [] } : diffLines(w.last_text ?? "", page.text);
                if (!added.length && !removed.length) {
                    return await this.deps.repo.saveCheck(w.id, { hash, text: page.text, match: null, result: "No change.", alerted: false, error: null, failCount: 0, pause: false });
                }
                const lines = added.slice(0, 6).map((l) => `+ ${l.slice(0, 160)}`);
                const summary = `${added.length} new line${added.length === 1 ? "" : "s"}${removed.length ? `, ${removed.length} removed` : ""}`;
                const body = [`Changed: ${summary}.`, ...lines, added.length > 6 ? `…and ${added.length - 6} more` : ""].filter(Boolean).join("\n");
                await this.deliver(w.user_id, "watcher", w.id, w.name, body, `👀 **${w.name}** changed\n${body}\n${w.url}`);
                return await this.deps.repo.saveCheck(w.id, { hash, text: page.text, match: null, result: `Changed: ${summary}`, alerted: true, error: null, failCount: 0, pause: false });
            }

            if (!this.deps.askModel) return await this.failed(w, "AI checks aren't available on this server");
            const prompt = [
                "You are checking a web page for the user.",
                `Condition: ${w.condition}`,
                "Answer on ONE line: start with YES or NO, then a short reason with the key detail you found (e.g. the current price). Say YES only if the condition is clearly true on the page right now.",
                `Page (${w.url}):\n"""\n${page.text.slice(0, AI_PAGE_CHARS)}\n"""`,
            ].join("\n\n");
            const r = await this.deps.askModel(w.user_id, prompt, AbortSignal.timeout(120_000));
            const yes = r.error ? null : parseYesNo(r.text);
            if (yes === null) return await this.failed(w, r.error ? `The AI check failed: ${r.error}` : "The AI didn't answer yes or no");
            const answer = r.text.trim().split("\n")[0].slice(0, 400);
            const alert = yes && w.last_match !== true;
            if (alert) await this.deliver(w.user_id, "watcher", w.id, w.name, answer, `👀 **${w.name}**: ${w.condition}\n${answer}\n${w.url}`);
            await this.deps.repo.saveCheck(w.id, { hash, text: null, match: yes, result: answer, alerted: alert, error: null, failCount: 0, pause: false });
        } finally {
            this.checking.delete(w.id);
        }
    }

    // Repeated failures pause the watcher (and say so once) instead of
    // retrying a dead page forever.
    private async failed(w: WatcherRow, error: string) {
        const failCount = w.fail_count + 1;
        const pause = failCount >= PAUSE_AFTER_FAILURES;
        if (pause) await this.deliver(w.user_id, "watcher", w.id, w.name, `Paused after ${failCount} failed checks: ${error}`, `⚠️ Stopped watching **${w.name}** after ${failCount} failed checks: ${error}\nResume it in Owl Bot → Reminders & alerts.`);
        await this.deps.repo.saveCheck(w.id, { hash: null, text: null, match: w.last_match, result: `Check failed: ${error}`, alerted: false, error, failCount, pause });
    }
}

export function taskDto(t: TaskRow) {
    return {
        id: t.id, title: t.title, notes: t.notes, status: t.status, repeat: t.repeat, timezone: t.timezone,
        remind_at: t.remind_at, remind_local: t.remind_at ? localIso(t.remind_at, t.timezone) : null,
        last_reminded_at: t.last_reminded_at, source: t.source, created_at: t.created_at, completed_at: t.completed_at,
    };
}

export function watcherDto(w: WatcherRow) {
    const { last_text: _t, last_hash: _h, ...rest } = w;
    return rest;
}
