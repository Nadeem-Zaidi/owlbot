import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { LLMMessage } from "../types/llm_message";
import { Session } from "../types/type";



export class SessionRepository {
    db: IDatabaseAdapter;
    constructor(db: IDatabaseAdapter) {
        this.db = db;
    }

    public async createSession(userId: string) {
        const result = await this.db.query<Session>(
            `INSERT INTO sessions (id,userid) VALUES ($1,$2) RETURNING *`,
            [randomUUID(), userId]
        );
        return result.rows[0];
    }

    async getSession(id: string) {
        const result = await this.db.query<Session>(`SELECT id, title, model, updated_at
                                            FROM sessions
                                            WHERE id = $1`, [id]);
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
        const result = await this.db.query<Session>(`SELECT id, title, updated_at
                                            FROM sessions
                                            WHERE userid = $1
                                            ORDER BY updated_at DESC`, [userId]);
        return result.rows;
    }

    async getSessionMessages(sessionId: string, userId: string) {
        const result = await this.db.query(`SELECT * FROM chat_messages WHERE session_id=$1  ORDER BY created_at ASC`, [sessionId]);
        return result.rows;
    }



    async deleteSession(sessionId: string, userId: string): Promise<void> {
        await this.db.withTransaction(async () => {
            await this.db.query(
                `DELETE FROM chat_messages WHERE session_id = $1`,
                [sessionId]
            );

            const result = await this.db.query(
                `DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2`,
                [sessionId, userId]
            );

            if (result.rowCount === 0) {
                throw new Error("Session not found or not owned by user");
            }
        });
    }
    async getOrCreateSession(userId: string, sessionId?: string) {
        if (sessionId) {
            const { rows } = await this.db.query(
                `SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2`,
                [sessionId, userId]
            );
            if (rows.length) return rows[0];
        }
        const { rows } = await this.db.query(
            `INSERT INTO chat_sessions (user_id, title)
            VALUES ($1, 'New Chat') RETURNING *`,
            [userId]
        );
        return rows[0];
    }

}