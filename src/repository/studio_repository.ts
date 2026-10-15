import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import type { StudioCanvas, TriggerType } from "../core/studio/studio_types";

export type StudioProjectRow = {
    id: string;
    user_id: string;
    name: string;
    description: string;
    canvas: StudioCanvas;
    pipeline_id: string | null;
    trigger_type: TriggerType;
    chat_command: string | null;
    deliver_result: boolean;
    webhook_hash: string | null;
    webhook_secret: string | null;
    next_run_at: Date | null;
    last_triggered_at: Date | null;
    created_at: Date;
    updated_at: Date;
};

export type StudioProjectInput = Pick<StudioProjectRow, "name" | "description" | "canvas" | "pipeline_id" | "trigger_type" | "chat_command" | "deliver_result" | "next_run_at">;

// SQL for Agent Studio projects; user queries are scoped to the owner.
export class StudioRepository {
    constructor(private db: IDatabaseAdapter) {}

    async list(userId: string): Promise<(StudioProjectRow & { last_run_status: string | null; last_run_at: Date | null })[]> {
        const { rows } = await this.db.query(
            `SELECT s.*,
                    (SELECT status FROM pipeline_runs r WHERE r.pipeline_id = s.pipeline_id ORDER BY r.started_at DESC LIMIT 1) AS last_run_status,
                    (SELECT started_at FROM pipeline_runs r WHERE r.pipeline_id = s.pipeline_id ORDER BY r.started_at DESC LIMIT 1) AS last_run_at
             FROM studio_projects s WHERE s.user_id = $1 ORDER BY s.updated_at DESC`,
            [userId],
        );
        return rows;
    }

    async get(id: string, userId: string): Promise<StudioProjectRow | null> {
        const { rows } = await this.db.query<StudioProjectRow>(`SELECT * FROM studio_projects WHERE id=$1 AND user_id=$2`, [id, userId]);
        return rows[0] ?? null;
    }

    async create(userId: string, p: StudioProjectInput): Promise<StudioProjectRow> {
        const { rows } = await this.db.query<StudioProjectRow>(
            `INSERT INTO studio_projects (id, user_id, name, description, canvas, pipeline_id, trigger_type, chat_command, deliver_result, next_run_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [randomUUID(), userId, p.name, p.description, JSON.stringify(p.canvas), p.pipeline_id, p.trigger_type, p.chat_command, p.deliver_result, p.next_run_at],
        );
        return rows[0];
    }

    async update(id: string, userId: string, p: StudioProjectInput): Promise<StudioProjectRow | null> {
        const { rows } = await this.db.query<StudioProjectRow>(
            `UPDATE studio_projects SET name=$3, description=$4, canvas=$5, pipeline_id=$6, trigger_type=$7, chat_command=$8,
                    deliver_result=$9, next_run_at=$10, updated_at=now()
             WHERE id=$1 AND user_id=$2 RETURNING *`,
            [id, userId, p.name, p.description, JSON.stringify(p.canvas), p.pipeline_id, p.trigger_type, p.chat_command, p.deliver_result, p.next_run_at],
        );
        return rows[0] ?? null;
    }

    async remove(id: string, userId: string): Promise<StudioProjectRow | null> {
        const { rows } = await this.db.query<StudioProjectRow>(`DELETE FROM studio_projects WHERE id=$1 AND user_id=$2 RETURNING *`, [id, userId]);
        return rows[0] ?? null;
    }

    // Another project of this user already answering /command?
    async commandOwner(userId: string, command: string): Promise<string | null> {
        const { rows } = await this.db.query<{ id: string }>(`SELECT id FROM studio_projects WHERE user_id=$1 AND chat_command=$2`, [userId, command]);
        return rows[0]?.id ?? null;
    }

    async byCommand(userId: string, command: string): Promise<StudioProjectRow | null> {
        const { rows } = await this.db.query<StudioProjectRow>(
            `SELECT * FROM studio_projects WHERE user_id=$1 AND chat_command=$2 AND trigger_type='chat'`, [userId, command]);
        return rows[0] ?? null;
    }

    async commands(userId: string): Promise<{ command: string; name: string }[]> {
        const { rows } = await this.db.query<{ command: string; name: string }>(
            `SELECT chat_command AS command, name FROM studio_projects
             WHERE user_id=$1 AND trigger_type='chat' AND chat_command IS NOT NULL AND pipeline_id IS NOT NULL ORDER BY chat_command`, [userId]);
        return rows;
    }

    async setWebhook(id: string, userId: string, hash: string | null, secret: string | null): Promise<void> {
        await this.db.query(`UPDATE studio_projects SET webhook_hash=$3, webhook_secret=$4 WHERE id=$1 AND user_id=$2`, [id, userId, hash, secret]);
    }

    async byWebhook(hash: string): Promise<StudioProjectRow | null> {
        const { rows } = await this.db.query<StudioProjectRow>(`SELECT * FROM studio_projects WHERE webhook_hash=$1 AND trigger_type='webhook'`, [hash]);
        return rows[0] ?? null;
    }

    async touchTriggered(id: string): Promise<void> {
        await this.db.query(`UPDATE studio_projects SET last_triggered_at=now() WHERE id=$1`, [id]);
    }

    async dueSchedules(limit: number): Promise<StudioProjectRow[]> {
        const { rows } = await this.db.query<StudioProjectRow>(
            `SELECT * FROM studio_projects
             WHERE trigger_type='schedule' AND next_run_at IS NOT NULL AND next_run_at <= now() AND pipeline_id IS NOT NULL
             ORDER BY next_run_at LIMIT $1`, [limit]);
        return rows;
    }

    // Moves a due slot forward; false when another server took it first.
    // Compared to the millisecond: JS dates drop Postgres' microseconds.
    async claimSchedule(id: string, dueAt: Date, next: Date): Promise<boolean> {
        const { rows } = await this.db.query(
            `UPDATE studio_projects SET next_run_at=$3, last_triggered_at=now()
             WHERE id=$1 AND date_trunc('milliseconds', next_run_at) = date_trunc('milliseconds', $2::timestamptz) RETURNING id`, [id, dueAt, next]);
        return rows.length > 0;
    }
}
