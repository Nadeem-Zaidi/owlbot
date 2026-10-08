import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { StoredSummary, SummaryStore } from "../core/context";

// Running summaries of long chats (context engine). Deleted with the session.
export class SessionSummaryRepository implements SummaryStore {
    constructor(private db: IDatabaseAdapter) {}

    async get(sessionId: string): Promise<StoredSummary | null> {
        const { rows } = await this.db.query<{ summary: string; upto_index: number }>(
            `SELECT summary, upto_index FROM session_summaries WHERE session_id = $1`, [sessionId]);
        return rows[0] ? { summary: rows[0].summary, uptoIndex: Number(rows[0].upto_index) } : null;
    }

    // Only moves forward: a slower, older compaction can't overwrite a newer one.
    async save(sessionId: string, summary: string, uptoIndex: number, model?: string): Promise<void> {
        await this.db.query(
            `INSERT INTO session_summaries (session_id, summary, upto_index, model, updated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (session_id) DO UPDATE
                SET summary = EXCLUDED.summary, upto_index = EXCLUDED.upto_index, model = EXCLUDED.model, updated_at = now()
                WHERE session_summaries.upto_index < EXCLUDED.upto_index`,
            [sessionId, summary, uptoIndex, model ?? null]
        );
    }
}
