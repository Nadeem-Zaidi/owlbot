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
    public async createSession(userId: string, source: "web" | "whatsapp" | "pipeline" = "web", title?: string) {
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
                    na.provider AS native_provider, s.updated_at
             FROM sessions s
             LEFT JOIN agents a ON a.id = s.agent_id
             LEFT JOIN native_agents na ON na.id = s.native_agent_id
             WHERE s.userid = $1 AND s.source <> 'pipeline'
             ORDER BY s.updated_at DESC`,
            [userId]
        );
        return result.rows;
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