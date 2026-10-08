import { randomInt } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { ChannelLink, ChannelLinkStore } from "../channels/core/chat_adapter";

const CODE_TTL_MINUTES = 10;
// No 0/O/1/I so codes are easy to read off a screen.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Row = {
    chat_id: string;
    user_id: string;
    display_name: string | null;
    active_session_id: string | null;
    provider: string | null;
    model: string | null;
    linked_at: Date;
};

const toLink = (r: Row | undefined): ChannelLink | null => r ? {
    chatId: r.chat_id,
    userId: r.user_id,
    displayName: r.display_name,
    activeSessionId: r.active_session_id,
    provider: r.provider,
    model: r.model,
    linkedAt: r.linked_at,
} : null;

// Linked chats and link codes for one channel ("telegram", …), in the
// shared channel_links / channel_link_codes tables.
export class ChannelLinkRepository implements ChannelLinkStore {
    constructor(private db: IDatabaseAdapter, readonly channel: string) {}

    // A fresh single-use code, retiring the user's older unused ones.
    async createCode(userId: string, sessionId: string | null): Promise<{ code: string; expiresAt: Date }> {
        const code = "OWL-" + Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
        return this.db.withTransaction(async () => {
            await this.db.query(`DELETE FROM channel_link_codes WHERE channel = $1 AND user_id = $2 AND used_at IS NULL`, [this.channel, userId]);
            const { rows } = await this.db.query<{ expires_at: Date }>(
                `INSERT INTO channel_link_codes (code, channel, user_id, session_id, expires_at)
                 VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval) RETURNING expires_at`,
                [code, this.channel, userId, sessionId, String(CODE_TTL_MINUTES)]
            );
            return { code, expiresAt: rows[0].expires_at };
        });
    }

    async consumeCode(code: string) {
        const { rows } = await this.db.query<{ user_id: string; session_id: string | null }>(
            `UPDATE channel_link_codes SET used_at = now()
             WHERE code = $1 AND channel = $2 AND used_at IS NULL AND expires_at > now()
             RETURNING user_id, session_id`,
            [code.toUpperCase(), this.channel]
        );
        return rows[0] ? { userId: rows[0].user_id, sessionId: rows[0].session_id } : null;
    }

    async getByChat(chatId: string) {
        const { rows } = await this.db.query<Row>(`SELECT * FROM channel_links WHERE channel = $1 AND chat_id = $2`, [this.channel, chatId]);
        return toLink(rows[0]);
    }

    async getByUser(userId: string) {
        const { rows } = await this.db.query<Row>(`SELECT * FROM channel_links WHERE channel = $1 AND user_id = $2`, [this.channel, userId]);
        return toLink(rows[0]);
    }

    async link(chatId: string, userId: string, displayName: string | null, sessionId: string | null) {
        await this.db.withTransaction(async () => {
            await this.db.query(`DELETE FROM channel_links WHERE channel = $1 AND (user_id = $2 OR chat_id = $3)`, [this.channel, userId, chatId]);
            await this.db.query(
                `INSERT INTO channel_links (channel, chat_id, user_id, display_name, active_session_id) VALUES ($1, $2, $3, $4, $5)`,
                [this.channel, chatId, userId, displayName, sessionId]
            );
        });
    }

    async setActiveSession(chatId: string, sessionId: string | null) {
        await this.db.query(`UPDATE channel_links SET active_session_id = $3 WHERE channel = $1 AND chat_id = $2`, [this.channel, chatId, sessionId]);
    }

    async setModel(chatId: string, provider: string, model: string) {
        await this.db.query(`UPDATE channel_links SET provider = $3, model = $4 WHERE channel = $1 AND chat_id = $2`, [this.channel, chatId, provider, model]);
    }

    async unlinkChat(chatId: string) {
        await this.db.query(`DELETE FROM channel_links WHERE channel = $1 AND chat_id = $2`, [this.channel, chatId]);
    }

    async unlinkUser(userId: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM channel_links WHERE channel = $1 AND user_id = $2`, [this.channel, userId]);
        return r.rowCount > 0;
    }
}
