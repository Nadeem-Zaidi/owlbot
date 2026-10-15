import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import type { Repeat } from "../core/automations/automation_time";

export type TaskRow = {
    id: string;
    user_id: string;
    title: string;
    notes: string;
    status: "open" | "done" | "cancelled";
    remind_at: Date | null;
    repeat: Repeat;
    timezone: string;
    anchor_day: number | null;
    last_reminded_at: Date | null;
    source: string;
    created_at: Date;
    updated_at: Date;
    completed_at: Date | null;
};

export type WatcherRow = {
    id: string;
    user_id: string;
    name: string;
    url: string;
    mode: "change" | "ai";
    condition: string;
    interval_minutes: number;
    status: "active" | "paused";
    next_check_at: Date | null;
    last_checked_at: Date | null;
    last_hash: string | null;
    last_text: string | null;
    last_match: boolean | null;
    last_result: string | null;
    last_alert_at: Date | null;
    last_error: string | null;
    fail_count: number;
    created_at: Date;
    updated_at: Date;
};

export type AlertRow = {
    id: number;
    user_id: string;
    kind: "reminder" | "watcher";
    ref_id: string | null;
    title: string;
    body: string;
    delivered_via: string;
    read_at: Date | null;
    created_at: Date;
};

export type TaskInput = Pick<TaskRow, "title" | "notes" | "remind_at" | "repeat" | "timezone" | "anchor_day">;
export type WatcherInput = Pick<WatcherRow, "name" | "url" | "mode" | "condition" | "interval_minutes">;

// SQL for reminders, to-dos, web watchers and the alerts inbox. User queries
// are scoped to the owner; the scheduler's claims are atomic so several
// servers can run it.
export class AutomationRepository {
    constructor(private db: IDatabaseAdapter) {}

    // ── settings ──
    async timezone(userId: string): Promise<string | null> {
        const { rows } = await this.db.query<{ timezone: string }>(`SELECT timezone FROM automation_settings WHERE user_id=$1`, [userId]);
        return rows[0]?.timezone ?? null;
    }

    async setTimezone(userId: string, tz: string): Promise<void> {
        await this.db.query(
            `INSERT INTO automation_settings (user_id, timezone) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET timezone=EXCLUDED.timezone, updated_at=now()`, [userId, tz]);
    }

    // ── tasks ──
    async listTasks(userId: string, status: "open" | "all"): Promise<TaskRow[]> {
        const { rows } = await this.db.query<TaskRow>(
            `SELECT * FROM tasks WHERE user_id=$1 ${status === "open" ? "AND status='open'" : "AND (status='open' OR completed_at > now() - interval '30 days')"}
             ORDER BY (status='open') DESC, remind_at ASC NULLS LAST, created_at DESC LIMIT 500`, [userId]);
        return rows;
    }

    async countOpenTasks(userId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE user_id=$1 AND status='open'`, [userId]);
        return Number(rows[0]?.n ?? 0);
    }

    async getTask(id: string, userId: string): Promise<TaskRow | null> {
        const { rows } = await this.db.query<TaskRow>(`SELECT * FROM tasks WHERE id=$1 AND user_id=$2`, [id, userId]);
        return rows[0] ?? null;
    }

    // An id or its first characters (as shown to the model).
    async findTask(userId: string, idOrPrefix: string): Promise<TaskRow[]> {
        const { rows } = await this.db.query<TaskRow>(
            `SELECT * FROM tasks WHERE user_id=$1 AND (id=$2 OR id LIKE $3) ORDER BY created_at DESC LIMIT 3`,
            [userId, idOrPrefix, `${idOrPrefix.replace(/[%_\\]/g, "")}%`]);
        return rows;
    }

    async createTask(userId: string, t: TaskInput, source: string): Promise<TaskRow> {
        const { rows } = await this.db.query<TaskRow>(
            `INSERT INTO tasks (id, user_id, title, notes, remind_at, repeat, timezone, anchor_day, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [randomUUID(), userId, t.title, t.notes, t.remind_at, t.repeat, t.timezone, t.anchor_day, source]);
        return rows[0];
    }

    async updateTask(id: string, userId: string, t: TaskInput): Promise<TaskRow | null> {
        const { rows } = await this.db.query<TaskRow>(
            `UPDATE tasks SET title=$3, notes=$4, remind_at=$5, repeat=$6, timezone=$7, anchor_day=$8, updated_at=now()
             WHERE id=$1 AND user_id=$2 RETURNING *`,
            [id, userId, t.title, t.notes, t.remind_at, t.repeat, t.timezone, t.anchor_day]);
        return rows[0] ?? null;
    }

    async setTaskStatus(id: string, userId: string, status: TaskRow["status"]): Promise<TaskRow | null> {
        const { rows } = await this.db.query<TaskRow>(
            `UPDATE tasks SET status=$3, completed_at=CASE WHEN $3='open' THEN NULL ELSE now() END, updated_at=now()
             WHERE id=$1 AND user_id=$2 RETURNING *`, [id, userId, status]);
        return rows[0] ?? null;
    }

    async deleteTask(id: string, userId: string): Promise<boolean> {
        const { rows } = await this.db.query(`DELETE FROM tasks WHERE id=$1 AND user_id=$2 RETURNING id`, [id, userId]);
        return rows.length > 0;
    }

    // Due reminders, each claimed by exactly one server (SKIP LOCKED). The
    // time is cleared while sending (so it can't go out twice) and returned
    // as due_at for working out the next repeat.
    async claimDueTasks(limit: number): Promise<(TaskRow & { due_at: Date })[]> {
        const { rows } = await this.db.query<TaskRow & { due_at: Date }>(
            `WITH due AS (
                SELECT id, remind_at AS due_at FROM tasks
                WHERE status='open' AND remind_at IS NOT NULL AND remind_at <= now()
                ORDER BY remind_at LIMIT $1 FOR UPDATE SKIP LOCKED
             )
             UPDATE tasks t SET last_reminded_at=now(), remind_at=NULL, updated_at=now()
             FROM due WHERE t.id = due.id
             RETURNING t.*, due.due_at`, [limit]);
        return rows;
    }

    // After sending: a repeating reminder gets its next time; a one-off is done.
    async afterReminder(id: string, next: Date | null): Promise<void> {
        await this.db.query(
            next
                ? `UPDATE tasks SET remind_at=$2, updated_at=now() WHERE id=$1 AND status='open'`
                : `UPDATE tasks SET status='done', completed_at=now(), updated_at=now() WHERE id=$1 AND status='open'`,
            next ? [id, next] : [id]);
    }

    // ── watchers ──
    async listWatchers(userId: string): Promise<WatcherRow[]> {
        const { rows } = await this.db.query<WatcherRow>(`SELECT * FROM web_watchers WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
        return rows;
    }

    async countWatchers(userId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM web_watchers WHERE user_id=$1`, [userId]);
        return Number(rows[0]?.n ?? 0);
    }

    async getWatcher(id: string, userId: string): Promise<WatcherRow | null> {
        const { rows } = await this.db.query<WatcherRow>(`SELECT * FROM web_watchers WHERE id=$1 AND user_id=$2`, [id, userId]);
        return rows[0] ?? null;
    }

    async findWatcher(userId: string, idOrPrefix: string): Promise<WatcherRow[]> {
        const { rows } = await this.db.query<WatcherRow>(
            `SELECT * FROM web_watchers WHERE user_id=$1 AND (id=$2 OR id LIKE $3) LIMIT 3`,
            [userId, idOrPrefix, `${idOrPrefix.replace(/[%_\\]/g, "")}%`]);
        return rows;
    }

    async createWatcher(userId: string, w: WatcherInput): Promise<WatcherRow> {
        const { rows } = await this.db.query<WatcherRow>(
            `INSERT INTO web_watchers (id, user_id, name, url, mode, condition, interval_minutes, next_check_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING *`,
            [randomUUID(), userId, w.name, w.url, w.mode, w.condition, w.interval_minutes]);
        return rows[0];
    }

    // Changing what's watched starts over (no stale baseline).
    async updateWatcher(id: string, userId: string, w: WatcherInput, reset: boolean): Promise<WatcherRow | null> {
        const { rows } = await this.db.query<WatcherRow>(
            `UPDATE web_watchers SET name=$3, url=$4, mode=$5, condition=$6, interval_minutes=$7, updated_at=now()
               ${reset ? ", last_hash=NULL, last_text=NULL, last_match=NULL, last_result=NULL, last_error=NULL, fail_count=0, next_check_at=now()" : ""}
             WHERE id=$1 AND user_id=$2 RETURNING *`,
            [id, userId, w.name, w.url, w.mode, w.condition, w.interval_minutes]);
        return rows[0] ?? null;
    }

    async setWatcherStatus(id: string, userId: string, status: WatcherRow["status"]): Promise<WatcherRow | null> {
        const { rows } = await this.db.query<WatcherRow>(
            `UPDATE web_watchers SET status=$3, fail_count=0, next_check_at=CASE WHEN $3='active' THEN now() ELSE next_check_at END, updated_at=now()
             WHERE id=$1 AND user_id=$2 RETURNING *`, [id, userId, status]);
        return rows[0] ?? null;
    }

    async deleteWatcher(id: string, userId: string): Promise<boolean> {
        const { rows } = await this.db.query(`DELETE FROM web_watchers WHERE id=$1 AND user_id=$2 RETURNING id`, [id, userId]);
        return rows.length > 0;
    }

    // Due watchers, claimed by pushing their next check forward first.
    async claimDueWatchers(limit: number): Promise<WatcherRow[]> {
        const { rows } = await this.db.query<WatcherRow>(
            `UPDATE web_watchers SET next_check_at = now() + make_interval(mins => interval_minutes)
             WHERE id IN (SELECT id FROM web_watchers WHERE status='active' AND next_check_at <= now()
                          ORDER BY next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED)
             RETURNING *`, [limit]);
        return rows;
    }

    async saveCheck(id: string, r: { hash: string | null; text: string | null; match: boolean | null; result: string; alerted: boolean; error: string | null; failCount: number; pause: boolean }): Promise<void> {
        await this.db.query(
            `UPDATE web_watchers SET last_checked_at=now(), last_hash=COALESCE($2, last_hash), last_text=COALESCE($3, last_text),
                    last_match=$4, last_result=$5, last_alert_at=CASE WHEN $6 THEN now() ELSE last_alert_at END,
                    last_error=$7, fail_count=$8, status=CASE WHEN $9 THEN 'paused' ELSE status END
             WHERE id=$1`,
            [id, r.hash, r.text, r.match, r.result.slice(0, 1000), r.alerted, r.error, r.failCount, r.pause]);
    }

    // ── alerts ──
    async addAlert(userId: string, a: { kind: AlertRow["kind"]; refId: string; title: string; body: string; via: string }): Promise<void> {
        await this.db.query(
            `INSERT INTO automation_alerts (user_id, kind, ref_id, title, body, delivered_via) VALUES ($1,$2,$3,$4,$5,$6)`,
            [userId, a.kind, a.refId, a.title.slice(0, 300), a.body.slice(0, 4000), a.via]);
    }

    async listAlerts(userId: string, limit: number): Promise<AlertRow[]> {
        const { rows } = await this.db.query<AlertRow>(`SELECT * FROM automation_alerts WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
        return rows;
    }

    async unreadAlerts(userId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM automation_alerts WHERE user_id=$1 AND read_at IS NULL`, [userId]);
        return Number(rows[0]?.n ?? 0);
    }

    async markAlertsRead(userId: string): Promise<void> {
        await this.db.query(`UPDATE automation_alerts SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [userId]);
    }
}
