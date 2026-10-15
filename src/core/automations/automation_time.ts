import { isValidTimezone, partsIn, zonedToUtc } from "../../service/agents/schedule_time";

// Reminder times are wall-clock times in the user's timezone, so "9:00 every
// day" stays at 9:00 across daylight-saving changes, and "the 31st every
// month" lands on the last day of shorter months.

export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
export const REPEATS: Repeat[] = ["none", "daily", "weekdays", "weekly", "monthly", "yearly"];

export { isValidTimezone };

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// "2026-10-20T09:00" or "2026-10-20 09:00" (wall time in tz) → the instant.
export function parseLocal(value: string, tz: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
    if (!m) return null;
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59) return null;
    return zonedToUtc(y, mo, d, h, mi, tz);
}

const pad = (n: number) => String(n).padStart(2, "0");

// The instant as "2026-10-20T09:00" in tz.
export function localIso(d: Date, tz: string): string {
    const p = partsIn(d, tz);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// "Tue 20 Oct 2026, 09:00" in tz.
export function formatLocal(d: Date, tz: string): string {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

export function dayOfMonth(d: Date, tz: string): number {
    return partsIn(d, tz).day;
}

// The next occurrence after `prev` (same wall time).
export function nextOccurrence(prev: Date, repeat: Repeat, tz: string, anchorDay: number | null): Date | null {
    if (repeat === "none") return null;
    const p = partsIn(prev, tz);
    let y = p.year, mo = p.month, d = p.day;
    const step = (days: number) => {
        const c = new Date(Date.UTC(y, mo - 1, d + days));
        y = c.getUTCFullYear(); mo = c.getUTCMonth() + 1; d = c.getUTCDate();
    };
    switch (repeat) {
        case "daily": step(1); break;
        case "weekly": step(7); break;
        case "weekdays":
            do step(1); while ([0, 6].includes(new Date(Date.UTC(y, mo - 1, d)).getUTCDay()));
            break;
        case "monthly":
            mo += 1;
            if (mo > 12) { mo = 1; y += 1; }
            d = Math.min(anchorDay ?? d, daysIn(y, mo));
            break;
        case "yearly":
            y += 1;
            d = Math.min(anchorDay ?? d, daysIn(y, mo));
            break;
    }
    return zonedToUtc(y, mo, d, p.hour, p.minute, tz);
}

// Skips occurrences that are already past (e.g. the server was down). Long
// gaps jump straight to the current period instead of stepping through it.
export function nextAfter(prev: Date, repeat: Repeat, tz: string, anchorDay: number | null, now: Date): Date | null {
    if (repeat === "none") return null;
    let next = nextOccurrence(prev, repeat, tz, anchorDay);
    if (next && next.getTime() <= now.getTime() - 40 * 24 * 3600_000) next = currentPeriod(prev, repeat, tz, anchorDay, now);
    for (let i = 0; next && next.getTime() <= now.getTime() && i < 400; i++) next = nextOccurrence(next, repeat, tz, anchorDay);
    return next;
}

// The occurrence in now's day / week / month / year, at prev's wall time.
function currentPeriod(prev: Date, repeat: Repeat, tz: string, anchorDay: number | null, now: Date): Date {
    const p = partsIn(prev, tz), n = partsIn(now, tz);
    let y = n.year, mo = n.month, d = n.day;
    if (repeat === "weekly") {
        const c = new Date(Date.UTC(y, mo - 1, d - ((n.weekday - p.weekday + 7) % 7)));
        y = c.getUTCFullYear(); mo = c.getUTCMonth() + 1; d = c.getUTCDate();
    } else if (repeat === "monthly") {
        d = Math.min(anchorDay ?? p.day, daysIn(y, mo));
    } else if (repeat === "yearly") {
        mo = p.month;
        d = Math.min(anchorDay ?? p.day, daysIn(y, mo));
    }
    return zonedToUtc(y, mo, d, p.hour, p.minute, tz);
}

export const REPEAT_LABEL: Record<Repeat, string> = {
    none: "once", daily: "every day", weekdays: "every weekday", weekly: "every week", monthly: "every month", yearly: "every year",
};
