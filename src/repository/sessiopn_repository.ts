import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { LLMMessage } from "../types/llm_message";
import { Session } from "../types/type";



export class SessionRepository {
    db: IDatabaseAdapter;
    constructor(db: IDatabaseAdapter) {
        this.db = db;
    }

    // `source` records where the chat started ("web" or "whatsapp").
    public async createSession(userId: string, source: "web" | "whatsapp" | "telegram" | "pipeline" = "web", title?: string) {
        const result = await this.db.query<Session>(
            `INSERT INTO sessions (id, userid, source, title) VALUES ($1, $2, $3, COALESCE($4, 'New Chat')) RETURNING *`,
            [randomUUID(), userId, source, title ?? null]
        );
        return result.rows[0];
    }

    // Scoped to the owner: another user's session id returns nothing, the
    // same as an id that doesn't exist.
    async getSession(id: string, userId: string) {
        const result = await this.db.query<Session>(`SELECT id, title, model, updated_at
                                            FROM sessions
                                            WHERE id = $1 AND userid = $2`, [id, userId]);
        return result.rows[0];

    }
    async updateTitle(id: string, userId: string, title: string) {
        const result = await this.db.query(
            `UPDATE sessions SET title = $1, updated_at = NOW() WHERE id = $2 AND userid = $3 RETURNING id, title, updated_at`,
            [title, id, userId]
        );
        return result.rows[0];
    }

    async getUserSessions(userId: string) {
        const result = await this.db.query<Session>(
            `SELECT s.id, s.title, s.source, s.agent_id, s.native_agent_id,
                    COALESCE(a.icon, na.icon) AS agent_icon, COALESCE(a.name, na.name) AS agent_name,
                    na.provider AS native_provider, s.updated_at, s.pinned_at
             FROM sessions s
             LEFT JOIN agents a ON a.id = s.agent_id
             LEFT JOIN native_agents na ON na.id = s.native_agent_id
             WHERE s.userid = $1 AND s.source <> 'pipeline'
             ORDER BY s.updated_at DESC`,
            [userId]
        );
        return result.rows;
    }

    // One page of the user's chats, newest activity first, for the "All
    // chats" list on the Search page. Keyset pagination on (updated_at, id):
    // `after` is the cursor_ts/id of the last row of the previous page.
    // cursor_ts is updated_at as text, so it keeps Postgres' microsecond
    // precision (a JS Date would round it and skip or repeat rows).
    async getUserSessionsPage(userId: string, limit: number, after?: { ts: string; id: string }) {
        const params: unknown[] = [userId, limit + 1];
        let cursorSql = "";
        if (after) {
            params.push(after.ts, after.id);
            cursorSql = "AND (s.updated_at, s.id) < ($3::timestamptz, $4::text)";
        }
        const result = await this.db.query<Session & { cursor_ts: string }>(
            `SELECT s.id, s.title, s.source, s.agent_id, s.native_agent_id,
                    COALESCE(a.icon, na.icon) AS agent_icon, COALESCE(a.name, na.name) AS agent_name,
                    na.provider AS native_provider, s.updated_at, s.pinned_at, s.updated_at::text AS cursor_ts
             FROM sessions s
             LEFT JOIN agents a ON a.id = s.agent_id
             LEFT JOIN native_agents na ON na.id = s.native_agent_id
             WHERE s.userid = $1 AND s.source <> 'pipeline' ${cursorSql}
             ORDER BY s.updated_at DESC, s.id DESC
             LIMIT $2`,
            params
        );
        const rows = result.rows;
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
            sessions: page.map(({ cursor_ts: _c, ...s }) => s),
            next: hasMore && last ? { ts: last.cursor_ts, id: last.id } : null,
        };
    }

    // Pins (favourites) or unpins a chat. Doesn't touch updated_at, so pinning
    // doesn't move it in Recents. Returns null if it isn't this user's chat.
    async setPinned(sessionId: string, userId: string, pinned: boolean): Promise<{ id: string; pinned_at: Date | null } | null> {
        const result = await this.db.query<{ id: string; pinned_at: Date | null }>(
            `UPDATE sessions SET pinned_at = CASE WHEN $3 THEN COALESCE(pinned_at, now()) ELSE NULL END
             WHERE id = $1 AND userid = $2 RETURNING id, pinned_at`,
            [sessionId, userId, pinned]
        );
        return result.rows[0] ?? null;
    }

    async countPinned(userId: string): Promise<number> {
        const result = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE userid = $1 AND pinned_at IS NOT NULL`, [userId]);
        return result.rows[0]?.n ?? 0;
    }

    async getSessionMessages(sessionId: string, userId: string) {
        const result = await this.db.query(
            `SELECT m.* FROM chat_messages m
             JOIN sessions s ON s.id = m.session_id
             WHERE m.session_id = $1 AND s.userid = $2
             ORDER BY m.id ASC`,
            [sessionId, userId]
        );
        return result.rows;
    }



    // chat_messages rows go with it via ON DELETE CASCADE.
    async deleteSession(sessionId: string, userId: string): Promise<void> {
        const result = await this.db.query(
            `DELETE FROM sessions WHERE id = $1 AND userid = $2`,
            [sessionId, userId]
        );
        if (result.rowCount === 0) {
            throw new Error("Session not found or not owned by user");
        }
    }

    async getOrCreateSession(userId: string, sessionId?: string) {
        if (sessionId) {
            const existing = await this.getSession(sessionId, userId);
            if (existing) return existing;
        }
        return this.createSession(userId);
    }
}