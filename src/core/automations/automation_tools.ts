import { ToolDefinition } from "../../types/type";
import { AutomationService } from "./automation_service";
import { formatLocal, localIso, REPEAT_LABEL } from "./automation_time";

export const AUTOMATION_TOOL_NAMES = ["create_task", "list_tasks", "update_task", "watch_webpage", "list_watchers", "stop_watcher"];

const short = (id: string) => id.slice(0, 8);
const need = (userId?: string) => {
    if (!userId) throw new Error("Reminders need a signed-in user.");
    return userId;
};

// Reminders, to-dos and web watchers from any chat (web, WhatsApp, Telegram).
export function createAutomationTools(svc: AutomationService): ToolDefinition[] {
    const describeTask = (t: { id: string; title: string; remind_at: Date | null; repeat: keyof typeof REPEAT_LABEL; timezone: string; status: string }) => ({
        id: short(t.id), title: t.title, status: t.status,
        when: t.remind_at ? `${formatLocal(new Date(t.remind_at), t.timezone)} (${t.timezone})` : "no time (to-do)",
        repeat: t.repeat === "none" ? undefined : REPEAT_LABEL[t.repeat],
    });

    return [
        {
            name: "create_task",
            description:
                "Creates a reminder or a to-do for the user. With a time (remind_at or in_minutes) it's a reminder: at that time it's sent to the user's " +
                "WhatsApp/Telegram (or shown in the app). Without a time it's a to-do on their list. Use it when the user says things like " +
                "\"remind me…\", \"don't let me forget…\", \"add to my to-do list…\", \"every Monday at 9 remind me…\". " +
                "remind_at is the user's LOCAL wall-clock time as YYYY-MM-DDTHH:MM; if you don't know today's date, call list_tasks first (it returns the current local time). " +
                "For \"in 20 minutes\" use in_minutes. Confirm the time back to the user in plain words.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "What to remind about / the to-do, short (e.g. \"Pay the electricity bill\")" },
                    remind_at: { type: "string", description: "Local date and time, YYYY-MM-DDTHH:MM (optional)" },
                    in_minutes: { type: "number", description: "Remind this many minutes from now (optional, instead of remind_at)" },
                    repeat: { type: "string", enum: ["none", "daily", "weekdays", "weekly", "monthly", "yearly"], description: "Repeat (needs a time). Default none." },
                    notes: { type: "string", description: "Extra details (optional)" },
                    timezone: { type: "string", description: "IANA timezone, only if the user names one (e.g. Asia/Kolkata). Default: theirs." },
                },
                required: ["title"],
            },
            execute: async (args, ctx) => {
                const t = await svc.createTask(need(ctx.userId), args, "chat");
                return { created: describeTask({ ...t, remind_at: t.remind_at ? new Date(t.remind_at) : null }), note: t.remind_at ? "It will be sent to their phone (WhatsApp/Telegram) if linked, otherwise shown under Reminders & alerts." : "Added to their to-do list." };
            },
        },
        {
            name: "list_tasks",
            description: "Lists the user's open reminders and to-dos (with ids), and returns the current local date and time. Use it to answer \"what's on my list\", before changing a task, or to learn today's date.",
            parameters: { type: "object", properties: { include_done: { type: "boolean", description: "Also show tasks completed in the last 30 days" } }, required: [] },
            execute: async (args, ctx) => {
                const userId = need(ctx.userId);
                const [tasks, tz] = await Promise.all([svc.listTasks(userId, args.include_done ? "all" : "open"), svc.timezone(userId)]);
                return {
                    now: `${formatLocal(new Date(), tz)} (${tz})`,
                    now_iso_local: localIso(new Date(), tz),
                    tasks: tasks.slice(0, 50).map((t) => describeTask({ ...t, remind_at: t.remind_at ? new Date(t.remind_at) : null })),
                    total: tasks.length,
                };
            },
        },
        {
            name: "update_task",
            description: "Changes one of the user's tasks by id (from list_tasks): mark it done, cancel it, reopen it, or snooze/reschedule a reminder.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "The task id (its first 8 characters are enough)" },
                    action: { type: "string", enum: ["done", "cancel", "reopen", "reschedule"], description: "What to do" },
                    remind_at: { type: "string", description: "For reschedule: new local time YYYY-MM-DDTHH:MM" },
                    in_minutes: { type: "number", description: "For reschedule/snooze: minutes from now" },
                },
                required: ["id", "action"],
            },
            execute: async (args, ctx) => {
                const userId = need(ctx.userId);
                const t = await svc.findTask(userId, args.id);
                if (args.action === "reschedule") {
                    const u = await svc.updateTask(userId, t.id, { title: t.title, notes: t.notes, repeat: t.repeat, timezone: t.timezone, remind_at: args.remind_at, in_minutes: args.in_minutes });
                    if (u.status !== "open") await svc.setTaskStatus(userId, t.id, "open");
                    return { rescheduled: describeTask({ ...u, status: "open", remind_at: u.remind_at ? new Date(u.remind_at) : null }) };
                }
                const status = args.action === "done" ? "done" : args.action === "cancel" ? "cancelled" : "open";
                const u = await svc.setTaskStatus(userId, t.id, status);
                return { updated: describeTask({ ...u, remind_at: u.remind_at ? new Date(u.remind_at) : null }) };
            },
        },
        {
            name: "watch_webpage",
            description:
                "Starts watching a public web page and alerts the user (WhatsApp/Telegram, or in the app) when it changes — or, with a condition, " +
                "when the condition becomes true (e.g. \"price below ₹50,000\", \"tickets are available\", \"a new job for React developers is posted\"). " +
                "Use it when the user asks to track, monitor or be told about something on a website.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "The page's full URL" },
                    condition: { type: "string", description: "What to look for (optional). Without it, any change alerts." },
                    name: { type: "string", description: "Short name, e.g. \"iPhone price\" (optional)" },
                    check_every_hours: { type: "number", description: "How often to check, 0.5 to 168 hours. Default 6." },
                },
                required: ["url"],
            },
            execute: async (args, ctx) => {
                const hours = Number(args.check_every_hours ?? 6);
                const w = await svc.createWatcher(need(ctx.userId), { url: args.url, condition: args.condition, name: args.name, interval_minutes: Math.round((Number.isFinite(hours) ? hours : 6) * 60) });
                return { watching: { id: short(w.id), name: w.name, url: w.url, mode: w.mode === "ai" ? `alerts when: ${w.condition}` : "alerts on any change", every_hours: w.interval_minutes / 60 }, note: "The first check runs within a minute." };
            },
        },
        {
            name: "list_watchers",
            description: "Lists the web pages the user is watching, with their last result.",
            parameters: { type: "object", properties: {}, required: [] },
            execute: async (_args, ctx) => ({
                watchers: (await svc.listWatchers(need(ctx.userId))).map((w) => ({
                    id: short(w.id), name: w.name, url: w.url, status: w.status,
                    watching_for: w.mode === "ai" ? w.condition : "any change", last_result: w.last_result,
                })),
            }),
        },
        {
            name: "stop_watcher",
            description: "Stops watching a page (deletes the watcher) by id from list_watchers.",
            parameters: { type: "object", properties: { id: { type: "string", description: "The watcher id" } }, required: ["id"] },
            execute: async (args, ctx) => {
                const userId = need(ctx.userId);
                const w = await svc.findWatcher(userId, args.id);
                await svc.deleteWatcher(userId, w.id);
                return { stopped: w.name };
            },
        },
    ];
}
