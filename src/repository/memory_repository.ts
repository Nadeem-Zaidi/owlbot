import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type MemoryStatus = "active" | "proposed";
export type MemorySource = "chat" | "user";
export type MemoryMode = "auto" | "review" | "off";

export type MemoryRow = {
    id: string;
    user_id: string;
    content: string;
    status: MemoryStatus;
    source: MemorySource;
    session_id: string | null;
    created_at: Date;
    updated_at: Date;
};

// Long-term memories (one short fact each) and each user's memory setting.
// Every query is scoped to the user.
export class MemoryRepository {
    constructor(private db: IDatabaseAdapter) {}

    async list(userId: string, status?: MemoryStatus): Promise<MemoryRow[]> {
        const { rows } = await this.db.query<MemoryRow>(
            `SELECT * FROM user_memories WHERE user_id = $1 ${status ? "AND status = $2" : ""} ORDER BY updated_at DESC`,
            status ? [userId, status] : [userId]
        );
        return rows;
    }

    async count(userId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM user_memories WHERE user_id = $1`, [userId]);
        return rows[0]?.n ?? 0;
    }

    async get(userId: string, id: string): Promise<MemoryRow | null> {
        const { rows } = await this.db.query<MemoryRow>(`SELECT * FROM user_memories WHERE user_id = $1 AND id = $2`, [userId, id]);
        return rows[0] ?? null;
    }

    // The assistant refers to memories by the first 8 characters of their id.
    async findByPrefix(userId: string, prefix: string): Promise<MemoryRow | null> {
        if (!/^[0-9a-f-]{4,36}$/i.test(prefix)) return null;
        const { rows } = await this.db.query<MemoryRow>(
            `SELECT * FROM user_memories WHERE user_id = $1 AND id LIKE $2 || '%' LIMIT 2`, [userId, prefix.toLowerCase()]);
        return rows.length === 1 ? rows[0] : null;
    }

    // Same text (ignoring case and spacing) already saved?
    async findSame(userId: string, content: string): Promise<MemoryRow | null> {
        const { rows } = await this.db.query<MemoryRow>(
            `SELECT * FROM user_memories WHERE user_id = $1 AND lower(regexp_replace(content, '\\s+', ' ', 'g')) = lower(regexp_replace($2, '\\s+', ' ', 'g')) LIMIT 1`,
            [userId, content]
        );
        return rows[0] ?? null;
    }

    async create(userId: string, content: string, status: MemoryStatus, source: MemorySource, sessionId: string | null): Promise<MemoryRow> {
        const { rows } = await this.db.query<MemoryRow>(
            `INSERT INTO user_memories (id, user_id, content, status, source, session_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [randomUUID(), userId, content, status, source, sessionId]
        );
        return rows[0];
    }

    async update(userId: string, id: string, patch: { content?: string; status?: MemoryStatus }): Promise<MemoryRow | null> {
        const { rows } = await this.db.query<MemoryRow>(
            `UPDATE user_memories SET content = COALESCE($3, content), status = COALESCE($4, status), updated_at = now()
             WHERE user_id = $1 AND id = $2 RETURNING *`,
            [userId, id, patch.content ?? null, patch.status ?? null]
        );
        return rows[0] ?? null;
    }

    async touch(userId: string, id: string): Promise<void> {
        await this.db.query(`UPDATE user_memories SET updated_at = now() WHERE user_id = $1 AND id = $2`, [userId, id]);
    }

    async delete(userId: string, id: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM user_memories WHERE user_id = $1 AND id = $2`, [userId, id]);
        return (r.rowCount ?? 0) > 0;
    }

    async deleteAll(userId: string): Promise<number> {
        const r = await this.db.query(`DELETE FROM user_memories WHERE user_id = $1`, [userId]);
        return r.rowCount ?? 0;
    }

    async getMode(userId: string): Promise<MemoryMode> {
        const { rows } = await this.db.query<{ mode: MemoryMode }>(`SELECT mode FROM user_memory_settings WHERE user_id = $1`, [userId]);
        return rows[0]?.mode ?? "auto";
    }

    async setMode(userId: string, mode: MemoryMode): Promise<void> {
        await this.db.query(
            `INSERT INTO user_memory_settings (user_id, mode, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
            [userId, mode]
        );
    }
}
