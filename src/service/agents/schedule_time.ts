// Next-run calculation for agent schedules. Times are wall-clock times in
// the schedule's IANA timezone (e.g. "09:00" in "Asia/Kolkata"), so a daily
// 9am run stays at 9am across daylight-saving changes.

export type Frequency = "hourly" | "daily" | "weekdays" | "weekly";

export type ScheduleTiming = {
    frequency: Frequency;
    interval_hours?: number | null;  // hourly: every N hours
    time_of_day?: string | null;     // "HH:MM" for daily / weekdays / weekly
    weekday?: number | null;         // weekly: 0 = Sunday … 6 = Saturday
    timezone: string;
};

export function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

// Wall-clock parts of `date` as seen in `tz`.
function partsIn(date: Date, tz: string) {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", second: "numeric", weekday: "short",
    });
    const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday };
}

// Milliseconds `tz` is ahead of UTC at `date`.
function offsetMs(date: Date, tz: string): number {
    const p = partsIn(date, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// The UTC instant when the clock in `tz` reads the given wall time. For a
// time skipped by a DST jump it lands just after the jump.
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const first = guess - offsetMs(new Date(guess), tz);
    const second = guess - offsetMs(new Date(first), tz);
    const p = partsIn(new Date(second), tz);
    if (p.hour === hour && p.minute === minute) return new Date(second);
    // The wall time doesn't exist (clocks jumped forward): take the later
    // candidate, which is the same distance past the jump.
    return new Date(Math.max(first, second));
}

function parseTime(t?: string | null): { hour: number; minute: number } {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? "");
    if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`Invalid time "${t}" — use HH:MM`);
    return { hour: +m[1], minute: +m[2] };
}

export function validateTiming(t: ScheduleTiming): void {
    if (!isValidTimezone(t.timezone)) throw new Error(`Unknown timezone "${t.timezone}"`);
    if (t.frequency === "hourly") {
        const n = Number(t.interval_hours);
        if (!Number.isInteger(n) || n < 1 || n > 168) throw new Error("Hourly schedules run every 1–168 hours");
        return;
    }
    if (!["daily", "weekdays", "weekly"].includes(t.frequency)) throw new Error(`Unknown frequency "${t.frequency}"`);
    parseTime(t.time_of_day);
    if (t.frequency === "weekly" && !(Number.isInteger(t.weekday) && t.weekday! >= 0 && t.weekday! <= 6)) {
        throw new Error("Weekly schedules need a weekday (0 = Sunday … 6 = Saturday)");
    }
}

/** First run time strictly after `after`. */
export function computeNextRun(t: ScheduleTiming, after: Date = new Date()): Date {
    validateTiming(t);
    if (t.frequency === "hourly") {
        const next = new Date(after.getTime() + Number(t.interval_hours) * 3600_000);
        next.setUTCSeconds(0, 0);
        return next;
    }

    const { hour, minute } = parseTime(t.time_of_day);
    const today = partsIn(after, t.timezone);
    // Walk forward day by day (at most 8) in the schedule's own calendar.
    for (let i = 0; i <= 8; i++) {
        const cal = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
        const weekday = cal.getUTCDay();
        if (t.frequency === "weekdays" && (weekday === 0 || weekday === 6)) continue;
        if (t.frequency === "weekly" && weekday !== t.weekday) continue;
        const candidate = zonedToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), hour, minute, t.timezone);
        if (candidate.getTime() > after.getTime()) return candidate;
    }
    throw new Error("Could not compute the next run time");
}

/** Human-readable summary, e.g. "Weekdays at 09:00 (Asia/Kolkata)". */
export function describeTiming(t: ScheduleTiming): string {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    switch (t.frequency) {
        case "hourly": return t.interval_hours === 1 ? "Every hour" : `Every ${t.interval_hours} hours`;
        case "daily": return `Daily at ${t.time_of_day} (${t.timezone})`;
        case "weekdays": return `Weekdays at ${t.time_of_day} (${t.timezone})`;
        case "weekly": return `Every ${days[t.weekday ?? 0]} at ${t.time_of_day} (${t.timezone})`;
    }
}
