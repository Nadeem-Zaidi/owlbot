import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type TokenCounts = {
    input_tokens: number;        // input not served from cache
    output_tokens: number;
    cache_read_tokens: number;   // input served from the prompt cache
    cache_write_tokens: number;  // input written to the prompt cache
};

export type UsageEntry = TokenCounts & {
    userId: string;
    sessionId?: string | null;
    agentId?: string | null;
    // "compaction": summarizing older messages of a long chat (context engine).
    kind: "chat" | "title" | "agent_draft" | "compaction";
    provider?: string | null;
    model?: string | null;
    requests?: number;
    // Ran on the user's own API key: shown in reports, never counted toward the plan.
    byok?: boolean;
    keyId?: string | null;
};

export const emptyCounts = (): TokenCounts => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
export const totalTokens = (c: TokenCounts) => c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_tokens;

type Grouped = TokenCounts & { requests: number };
const SUMS = `COALESCE(SUM(input_tokens),0)::int AS input_tokens,
              COALESCE(SUM(output_tokens),0)::int AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0)::int AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens),0)::int AS cache_write_tokens,
              COALESCE(SUM(requests),0)::int AS requests`;

// Token usage records and reports. Every report is scoped to one user.
export class UsageRepository {
    constructor(private db: IDatabaseAdapter) {}

    async record(e: UsageEntry): Promise<void> {
        // source / agent_id are copied from the session so reports still
        // work after the chat is deleted.
        await this.db.query(
            `INSERT INTO token_usage (user_id, session_id, agent_id, source, kind, provider, model,
                                      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, requests, byok, key_id)
             VALUES ($1, $2,
                     COALESCE($3, (SELECT agent_id FROM sessions WHERE id = $2)),
                     (SELECT source FROM sessions WHERE id = $2),
                     $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [e.userId, e.sessionId ?? null, e.agentId ?? null, e.kind, e.provider ?? null, e.model ?? null,
             e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_write_tokens, e.requests ?? 1,
             e.byok ?? false, e.keyId ?? null]
        );
    }

    async lastMessageId(sessionId: string): Promise<number> {
        const { rows } = await this.db.query<{ id: number | null }>(`SELECT max(id) AS id FROM chat_messages WHERE session_id = $1`, [sessionId]);
        return Number(rows[0]?.id ?? 0);
    }

    // Stores the turn's usage on the turn's final reply, so the chat can show
    // it next to that message after a reload.
    async attachToLastReply(sessionId: string, afterMessageId: number, usage: Record<string, unknown>): Promise<void> {
        await this.db.query(
            `UPDATE chat_messages
             SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('usage', $3::jsonb)
             WHERE id = (SELECT id FROM chat_messages WHERE session_id = $1 AND role = 'assistant' AND id > $2 ORDER BY id DESC LIMIT 1)`,
            [sessionId, afterMessageId, JSON.stringify(usage)]
        );
    }

    async summary(userId: string, days: number) {
        const since = [userId, days];
        const where = `user_id = $1 AND created_at >= now() - ($2 || ' days')::interval`;
        const [totals, byDay, byModel, bySource, topChats, byok] = await Promise.all([
            this.db.query<Grouped>(`SELECT ${SUMS} FROM token_usage WHERE ${where}`, since),
            this.db.query<Grouped & { day: string }>(
                `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, ${SUMS}
                 FROM token_usage WHERE ${where} GROUP BY 1 ORDER BY 1`, since),
            this.db.query<Grouped & { provider: string | null; model: string | null; byok: boolean }>(
                `SELECT provider, model, byok, ${SUMS} FROM token_usage WHERE ${where} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, since),
            this.db.query<Grouped & { source: string }>(
                `SELECT CASE WHEN kind = 'agent_draft' THEN 'agent_builder'
                             WHEN source = 'whatsapp' THEN 'whatsapp'
                             WHEN source = 'telegram' THEN 'telegram'
                             WHEN source = 'pipeline' THEN 'pipeline'
                             WHEN agent_id IS NOT NULL THEN 'agent'
                             ELSE 'chat' END AS source, ${SUMS}
                 FROM token_usage WHERE ${where} GROUP BY 1 ORDER BY 1`, since),
            this.db.query<Grouped & { session_id: string; title: string | null }>(
                `SELECT u.session_id, s.title, ${SUMS.replace(/SUM\(/g, "SUM(u.")}
                 FROM token_usage u JOIN sessions s ON s.id = u.session_id
                 WHERE u.user_id = $1 AND u.created_at >= now() - ($2 || ' days')::interval AND s.source <> 'pipeline'
                 GROUP BY 1, 2
                 ORDER BY SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) DESC
                 LIMIT 10`, since),
            this.db.query<Grouped>(`SELECT ${SUMS} FROM token_usage WHERE ${where} AND byok`, since),
        ]);
        return { totals: totals.rows[0], byok: byok.rows[0], byDay: byDay.rows, byModel: byModel.rows, bySource: bySource.rows, topChats: topChats.rows };
    }

    async sessionTotals(userId: string, sessionId: string): Promise<Grouped> {
        const { rows } = await this.db.query<Grouped>(`SELECT ${SUMS} FROM token_usage WHERE user_id = $1 AND session_id = $2`, [userId, sessionId]);
        return rows[0];
    }
}
