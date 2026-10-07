import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type LLMKeyKind = "openai" | "anthropic" | "openai_compatible";

// A user's own provider key (BYOK). `api_key_enc` is encrypted at rest and
// never leaves the server; `key_hint` (last characters) is what the UI shows.
export type LLMKeyRow = {
    id: string;
    user_id: string;
    kind: LLMKeyKind;
    label: string;
    base_url: string | null;
    api_key_enc: string;
    key_hint: string;
    models: string[];
    default_model: string | null;
    enabled: boolean;
    last_verified_at: Date | null;
    last_error: string | null;
    created_at: Date;
    updated_at: Date;
};

export type LLMKeyInput = {
    kind: LLMKeyKind;
    label: string;
    base_url: string | null;
    api_key_enc: string;
    key_hint: string;
    models: string[];
    default_model: string | null;
    enabled: boolean;
};

const COLS = `id, user_id, kind, label, base_url, api_key_enc, key_hint, models, default_model, enabled,
              last_verified_at, last_error, created_at, updated_at`;

// Every query is scoped to the owning user.
export class LLMKeyRepository {
    constructor(private db: IDatabaseAdapter) {}

    async list(userId: string): Promise<LLMKeyRow[]> {
        const { rows } = await this.db.query<LLMKeyRow>(
            `SELECT ${COLS} FROM user_llm_keys WHERE user_id = $1 ORDER BY created_at`, [userId]);
        return rows;
    }

    async get(userId: string, id: string): Promise<LLMKeyRow | null> {
        const { rows } = await this.db.query<LLMKeyRow>(
            `SELECT ${COLS} FROM user_llm_keys WHERE user_id = $1 AND id = $2`, [userId, id]);
        return rows[0] ?? null;
    }

    async count(userId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_llm_keys WHERE user_id = $1`, [userId]);
        return rows[0]?.n ?? 0;
    }

    async create(userId: string, k: LLMKeyInput): Promise<LLMKeyRow> {
        const { rows } = await this.db.query<LLMKeyRow>(
            `INSERT INTO user_llm_keys (id, user_id, kind, label, base_url, api_key_enc, key_hint, models, default_model, enabled, last_verified_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, now())
             RETURNING ${COLS}`,
            [randomUUID(), userId, k.kind, k.label, k.base_url, k.api_key_enc, k.key_hint, JSON.stringify(k.models), k.default_model, k.enabled]
        );
        return rows[0];
    }

    async update(userId: string, id: string, k: LLMKeyInput, verified: boolean): Promise<LLMKeyRow | null> {
        const { rows } = await this.db.query<LLMKeyRow>(
            `UPDATE user_llm_keys
             SET kind = $3, label = $4, base_url = $5, api_key_enc = $6, key_hint = $7, models = $8::jsonb,
                 default_model = $9, enabled = $10, updated_at = now(),
                 last_verified_at = CASE WHEN $11 THEN now() ELSE last_verified_at END,
                 last_error = CASE WHEN $11 THEN NULL ELSE last_error END
             WHERE user_id = $1 AND id = $2
             RETURNING ${COLS}`,
            [userId, id, k.kind, k.label, k.base_url, k.api_key_enc, k.key_hint, JSON.stringify(k.models), k.default_model, k.enabled, verified]
        );
        return rows[0] ?? null;
    }

    async recordError(id: string, message: string | null): Promise<void> {
        await this.db.query(`UPDATE user_llm_keys SET last_error = $2 WHERE id = $1`, [id, message?.slice(0, 500) ?? null]);
    }

    async remove(userId: string, id: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM user_llm_keys WHERE user_id = $1 AND id = $2`, [userId, id]);
        return (r.rowCount ?? 0) > 0;
    }
}
