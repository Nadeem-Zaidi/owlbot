import { randomInt } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type WhatsAppLink = {
    jid: string;
    user_id: string;
    display_name: string | null;
    active_session_id: string | null;
    provider: string | null;
    model: string | null;
    linked_at: Date;
};

export type ConsumedCode = { user_id: string; session_id: string | null };

const CODE_TTL_MINUTES = 10;
// No 0/O/1/I so codes are easy to read off a screen.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class WhatsAppRepository {
    constructor(private db: IDatabaseAdapter) {}

    // Issues a fresh single-use code, retiring the user's older unused ones.
    async createCode(userId: string, sessionId: string | null): Promise<{ code: string; expiresAt: Date }> {
        const code = "OWL-" + Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
        return this.db.withTransaction(async () => {
            await this.db.query(
                `DELETE FROM whatsapp_link_codes WHERE user_id = $1 AND used_at IS NULL`,
                [userId]
            );
            const { rows } = await this.db.query<{ expires_at: Date }>(
                `INSERT INTO whatsapp_link_codes (code, user_id, session_id, expires_at)
                 VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)
                 RETURNING expires_at`,
                [code, userId, sessionId, String(CODE_TTL_MINUTES)]
            );
            return { code, expiresAt: rows[0].expires_at };
        });
    }

    // Atomically marks a code used; null if unknown, already used or expired.
    async consumeCode(code: string): Promise<ConsumedCode | null> {
        const { rows } = await this.db.query<ConsumedCode>(
            `UPDATE whatsapp_link_codes SET used_at = now()
             WHERE code = $1 AND used_at IS NULL AND expires_at > now()
             RETURNING user_id, session_id`,
            [code.toUpperCase()]
        );
        return rows[0] ?? null;
    }

    // Links `jid` to the user, replacing any previous number for that user
    // and any previous owner of that number.
    async link(jid: string, userId: string, displayName: string | null, activeSessionId: string | null): Promise<void> {
        await this.db.withTransaction(async () => {
            await this.db.query(`DELETE FROM whatsapp_links WHERE user_id = $1 OR jid = $2`, [userId, jid]);
            await this.db.query(
                `INSERT INTO whatsapp_links (jid, user_id, display_name, active_session_id) VALUES ($1, $2, $3, $4)`,
                [jid, userId, displayName, activeSessionId]
            );
        });
    }

    async getByJid(jid: string): Promise<WhatsAppLink | null> {
        const { rows } = await this.db.query<WhatsAppLink>(`SELECT * FROM whatsapp_links WHERE jid = $1`, [jid]);
        return rows[0] ?? null;
    }

    async getByUser(userId: string): Promise<WhatsAppLink | null> {
        const { rows } = await this.db.query<WhatsAppLink>(`SELECT * FROM whatsapp_links WHERE user_id = $1`, [userId]);
        return rows[0] ?? null;
    }

    async setActiveSession(jid: string, sessionId: string | null): Promise<void> {
        await this.db.query(`UPDATE whatsapp_links SET active_session_id = $2 WHERE jid = $1`, [jid, sessionId]);
    }

    async setModel(jid: string, provider: string, model: string): Promise<void> {
        await this.db.query(`UPDATE whatsapp_links SET provider = $2, model = $3 WHERE jid = $1`, [jid, provider, model]);
    }

    async unlinkUser(userId: string): Promise<boolean> {
        const result = await this.db.query(`DELETE FROM whatsapp_links WHERE user_id = $1`, [userId]);
        return result.rowCount > 0;
    }

    async unlinkJid(jid: string): Promise<void> {
        await this.db.query(`DELETE FROM whatsapp_links WHERE jid = $1`, [jid]);
    }

    // ── away message ──
    async getAway(): Promise<AwaySettings> {
        const { rows } = await this.db.query<AwaySettings>(
            `SELECT enabled, message, cooldown_minutes, until, updated_at FROM whatsapp_away WHERE id = 1`);
        return rows[0] ?? { enabled: false, message: "", cooldown_minutes: 720, until: null, updated_at: null };
    }

    // Turning it on starts fresh: everyone may get the message once again.
    async saveAway(a: Pick<AwaySettings, "enabled" | "message" | "cooldown_minutes" | "until">, updatedBy: string): Promise<AwaySettings> {
        return this.db.withTransaction(async () => {
            const before = await this.getAway();
            if (a.enabled && !before.enabled) await this.db.query(`DELETE FROM whatsapp_away_replies`);
            await this.db.query(
                `INSERT INTO whatsapp_away (id, enabled, message, cooldown_minutes, until, updated_by, updated_at)
                 VALUES (1, $1, $2, $3, $4, $5, now())
                 ON CONFLICT (id) DO UPDATE SET enabled = $1, message = $2, cooldown_minutes = $3, until = $4, updated_by = $5, updated_at = now()`,
                [a.enabled, a.message, a.cooldown_minutes, a.until, updatedBy]
            );
            return this.getAway();
        });
    }

    async disableAway(): Promise<void> {
        await this.db.query(`UPDATE whatsapp_away SET enabled = false, updated_at = now() WHERE id = 1`);
    }

    // Records a reply to `jid` unless it already got one within the cooldown.
    // Atomic, so two quick messages from the same person send one reply.
    async claimAwayReply(jid: string, name: string | null, cooldownMinutes: number): Promise<boolean> {
        const { rows } = await this.db.query(
            `INSERT INTO whatsapp_away_replies (jid, name) VALUES ($1, $2)
             ON CONFLICT (jid) DO UPDATE SET replied_at = now(), name = COALESCE(EXCLUDED.name, whatsapp_away_replies.name),
                    reply_count = whatsapp_away_replies.reply_count + 1
             WHERE whatsapp_away_replies.replied_at < now() - make_interval(mins => $3)
             RETURNING jid`,
            [jid, name, cooldownMinutes]
        );
        return rows.length > 0;
    }

    // Undo a claim when the send failed, so the person isn't skipped.
    async releaseAwayReply(jid: string): Promise<void> {
        await this.db.query(`DELETE FROM whatsapp_away_replies WHERE jid = $1 AND replied_at > now() - interval '1 minute'`, [jid]);
    }

    async awayRecipients(limit = 5): Promise<{ total: number; recent: { jid: string; name: string | null; replied_at: Date; reply_count: number }[] }> {
        const [count, recent] = await Promise.all([
            this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM whatsapp_away_replies`),
            this.db.query<{ jid: string; name: string | null; replied_at: Date; reply_count: number }>(
                `SELECT jid, name, replied_at, reply_count FROM whatsapp_away_replies ORDER BY replied_at DESC LIMIT $1`, [limit]),
        ]);
        return { total: count.rows[0]?.n ?? 0, recent: recent.rows };
    }
}

export type AwaySettings = {
    enabled: boolean;
    message: string;
    cooldown_minutes: number;
    until: Date | null;
    updated_at: Date | null;
};
