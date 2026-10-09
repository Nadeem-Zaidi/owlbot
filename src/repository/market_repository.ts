import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type LedgerKind = "purchase" | "usage" | "refund" | "adjustment";

export type LedgerEntry = {
    kind: LedgerKind;
    amountNanos: number;          // + adds credit, - spends it
    upstreamNanos?: number;
    feePaise?: number;
    paidPaise?: number;
    model?: string | null;
    source?: string | null;       // "chat" | "api" | "razorpay" | …
    provider?: string | null;     // who served a usage entry
    apiKeyId?: string | null;
    sessionId?: string | null;
    generationId?: string | null;
    paymentId?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    note?: string | null;
};

export type LedgerRow = {
    id: string;
    kind: LedgerKind;
    amount_nanos: string;
    balance_after_nanos: string;
    upstream_nanos: string;
    fee_paise: string;
    paid_paise: string;
    model: string | null;
    source: string | null;
    api_key_id: string | null;
    input_tokens: string;
    output_tokens: string;
    note: string | null;
    created_at: Date;
};

export type OrderRow = {
    id: string;
    user_id: string;
    credits_nanos: string;
    amount_paise: string;
    fee_paise: string;
    usd_inr: string;
    status: string;
    payment_id: string | null;
    created_at: Date;
    paid_at: Date | null;
};

export type ApiKeyRow = {
    id: string;
    user_id: string;
    name: string;
    key_hash: string;
    key_prefix: string;
    key_last4: string;
    limit_nanos: string | null;
    usage_nanos: string;
    disabled: boolean;
    created_at: Date;
    last_used_at: Date | null;
};

export class DuplicatePaymentError extends Error {}

const num = (v: string | number | null | undefined) => Number(v ?? 0);

// Marketplace data. Every balance change is ONE statement that updates the
// wallet and writes its ledger row together, so they can't drift apart, and
// a payment id can be credited only once (unique index).
export class MarketRepository {
    constructor(private db: IDatabaseAdapter) {}

    async balance(userId: string): Promise<number> {
        const { rows } = await this.db.query<{ balance_nanos: string }>(`SELECT balance_nanos FROM market_wallets WHERE user_id = $1`, [userId]);
        return num(rows[0]?.balance_nanos);
    }

    // Applies a ledger entry atomically and returns the new balance.
    async apply(userId: string, e: LedgerEntry): Promise<number> {
        await this.db.query(`INSERT INTO market_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
        try {
            const { rows } = await this.db.query<{ balance_after_nanos: string }>(
                `WITH w AS (
                    UPDATE market_wallets SET balance_nanos = balance_nanos + $2, updated_at = now()
                    WHERE user_id = $1 RETURNING balance_nanos
                 )
                 INSERT INTO market_ledger (user_id, kind, amount_nanos, balance_after_nanos, upstream_nanos, fee_paise, paid_paise,
                                            model, source, api_key_id, session_id, generation_id, payment_id, input_tokens, output_tokens, note, provider)
                 SELECT $1, $3, $2, w.balance_nanos, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16 FROM w
                 RETURNING balance_after_nanos`,
                [userId, Math.round(e.amountNanos), e.kind, Math.round(e.upstreamNanos ?? 0), Math.round(e.feePaise ?? 0), Math.round(e.paidPaise ?? 0),
                    e.model ?? null, e.source ?? null, e.apiKeyId ?? null, e.sessionId ?? null, e.generationId ?? null, e.paymentId ?? null,
                    Math.round(e.inputTokens ?? 0), Math.round(e.outputTokens ?? 0), e.note ?? null, e.provider ?? null],
            );
            return num(rows[0]?.balance_after_nanos);
        } catch (err: any) {
            if (err?.code === "23505" && e.paymentId) throw new DuplicatePaymentError(`Payment ${e.paymentId} was already credited`);
            throw err;
        }
    }

    async ledger(userId: string, limit = 50, before?: string | null): Promise<LedgerRow[]> {
        const { rows } = await this.db.query<LedgerRow>(
            `SELECT id, kind, amount_nanos, balance_after_nanos, upstream_nanos, fee_paise, paid_paise, model, source, api_key_id,
                    input_tokens, output_tokens, note, created_at
             FROM market_ledger WHERE user_id = $1 ${before ? "AND id < $3" : ""} ORDER BY id DESC LIMIT $2`,
            before ? [userId, limit, before] : [userId, limit],
        );
        return rows;
    }

    // Usage per model over the last `days` (for the user's credits page).
    async usageByModel(userId: string, days: number) {
        const { rows } = await this.db.query<{ model: string; requests: string; spent: string; input_tokens: string; output_tokens: string }>(
            `SELECT model, COUNT(*) AS requests, -SUM(amount_nanos) AS spent, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
             FROM market_ledger WHERE user_id = $1 AND kind = 'usage' AND created_at > now() - make_interval(days => $2)
             GROUP BY model ORDER BY spent DESC LIMIT 20`,
            [userId, days],
        );
        return rows.map((r) => ({ model: r.model, requests: num(r.requests), spentNanos: num(r.spent), inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens) }));
    }

    // ── orders ──
    async createOrder(o: { id: string; userId: string; creditsNanos: number; amountPaise: number; feePaise: number; usdInr: number }): Promise<void> {
        await this.db.query(
            `INSERT INTO market_orders (id, user_id, credits_nanos, amount_paise, fee_paise, usd_inr) VALUES ($1, $2, $3, $4, $5, $6)`,
            [o.id, o.userId, o.creditsNanos, o.amountPaise, o.feePaise, o.usdInr],
        );
    }

    async getOrder(id: string): Promise<OrderRow | null> {
        const { rows } = await this.db.query<OrderRow>(`SELECT * FROM market_orders WHERE id = $1`, [id]);
        return rows[0] ?? null;
    }

    // Marks an order paid; true only for the caller that changed it.
    async markOrderPaid(id: string, paymentId: string): Promise<boolean> {
        const { rowCount } = await this.db.query(
            `UPDATE market_orders SET status = 'paid', payment_id = $2, paid_at = now() WHERE id = $1 AND status <> 'paid'`,
            [id, paymentId],
        );
        return rowCount > 0;
    }

    async markOrderStatus(id: string, status: string): Promise<void> {
        await this.db.query(`UPDATE market_orders SET status = $2 WHERE id = $1 AND status <> 'paid'`, [id, status]);
    }

    // ── developer API keys ──
    async createKey(k: { id: string; userId: string; name: string; hash: string; prefix: string; last4: string; limitNanos: number | null }): Promise<ApiKeyRow> {
        const { rows } = await this.db.query<ApiKeyRow>(
            `INSERT INTO market_api_keys (id, user_id, name, key_hash, key_prefix, key_last4, limit_nanos) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [k.id, k.userId, k.name, k.hash, k.prefix, k.last4, k.limitNanos],
        );
        return rows[0];
    }

    async keys(userId: string): Promise<ApiKeyRow[]> {
        const { rows } = await this.db.query<ApiKeyRow>(`SELECT * FROM market_api_keys WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
        return rows;
    }

    async countKeys(userId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM market_api_keys WHERE user_id = $1`, [userId]);
        return num(rows[0]?.n);
    }

    async keyByHash(hash: string): Promise<ApiKeyRow | null> {
        const { rows } = await this.db.query<ApiKeyRow>(`SELECT * FROM market_api_keys WHERE key_hash = $1`, [hash]);
        return rows[0] ?? null;
    }

    async updateKey(userId: string, id: string, patch: { name?: string; disabled?: boolean; limitNanos?: number | null }): Promise<ApiKeyRow | null> {
        const { rows } = await this.db.query<ApiKeyRow>(
            `UPDATE market_api_keys SET
                name = COALESCE($3, name),
                disabled = COALESCE($4, disabled),
                limit_nanos = CASE WHEN $5::boolean THEN $6::bigint ELSE limit_nanos END
             WHERE user_id = $1 AND id = $2 RETURNING *`,
            [userId, id, patch.name ?? null, patch.disabled ?? null, patch.limitNanos !== undefined, patch.limitNanos ?? null],
        );
        return rows[0] ?? null;
    }

    async deleteKey(userId: string, id: string): Promise<boolean> {
        const { rowCount } = await this.db.query(`DELETE FROM market_api_keys WHERE user_id = $1 AND id = $2`, [userId, id]);
        return rowCount > 0;
    }

    async addKeyUsage(id: string, nanos: number): Promise<void> {
        await this.db.query(`UPDATE market_api_keys SET usage_nanos = usage_nanos + $2, last_used_at = now() WHERE id = $1`, [id, Math.round(nanos)]);
    }

    // ── favourite models (shown in the chat model picker) ──
    async favorites(userId: string): Promise<string[]> {
        const { rows } = await this.db.query<{ model_id: string }>(`SELECT model_id FROM market_favorites WHERE user_id = $1 ORDER BY created_at`, [userId]);
        return rows.map((r) => r.model_id);
    }

    async addFavorite(userId: string, modelId: string): Promise<void> {
        await this.db.query(`INSERT INTO market_favorites (user_id, model_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, modelId]);
    }

    async removeFavorite(userId: string, modelId: string): Promise<void> {
        await this.db.query(`DELETE FROM market_favorites WHERE user_id = $1 AND model_id = $2`, [userId, modelId]);
    }

    async countFavorites(userId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM market_favorites WHERE user_id = $1`, [userId]);
        return num(rows[0]?.n);
    }

    // ── owner: earnings ──
    async earnings(days: number) {
        const p = [days];
        const since = `created_at > now() - make_interval(days => $1)`;
        const [totals, daily, models, users, liability, allTime, providers, spend30] = await Promise.all([
            this.db.query<any>(
                `SELECT
                    COALESCE(SUM(paid_paise) FILTER (WHERE kind = 'purchase'), 0) AS paid_paise,
                    COALESCE(SUM(fee_paise) FILTER (WHERE kind = 'purchase'), 0) AS fee_paise,
                    COALESCE(SUM(amount_nanos) FILTER (WHERE kind = 'purchase'), 0) AS credits_sold_nanos,
                    COUNT(*) FILTER (WHERE kind = 'purchase') AS purchases,
                    COALESCE(-SUM(amount_nanos) FILTER (WHERE kind = 'usage'), 0) AS usage_charged_nanos,
                    COALESCE(SUM(upstream_nanos) FILTER (WHERE kind = 'usage'), 0) AS upstream_nanos,
                    COUNT(*) FILTER (WHERE kind = 'usage') AS requests,
                    COUNT(DISTINCT user_id) FILTER (WHERE kind = 'usage') AS active_users
                 FROM market_ledger WHERE ${since}`, p),
            this.db.query<any>(
                `SELECT date_trunc('day', created_at) AS day,
                    COALESCE(SUM(fee_paise) FILTER (WHERE kind = 'purchase'), 0) AS fee_paise,
                    COALESCE(SUM(paid_paise) FILTER (WHERE kind = 'purchase'), 0) AS paid_paise,
                    COALESCE(-SUM(amount_nanos) FILTER (WHERE kind = 'usage'), 0) AS usage_charged_nanos,
                    COALESCE(SUM(upstream_nanos) FILTER (WHERE kind = 'usage'), 0) AS upstream_nanos
                 FROM market_ledger WHERE ${since} GROUP BY 1 ORDER BY 1`, p),
            this.db.query<any>(
                `SELECT model, COUNT(*) AS requests, -SUM(amount_nanos) AS charged_nanos, SUM(upstream_nanos) AS upstream_nanos
                 FROM market_ledger WHERE ${since} AND kind = 'usage' GROUP BY model ORDER BY charged_nanos DESC LIMIT 10`, p),
            this.db.query<any>(
                `SELECT user_id,
                    COALESCE(SUM(paid_paise) FILTER (WHERE kind = 'purchase'), 0) AS paid_paise,
                    COALESCE(-SUM(amount_nanos) FILTER (WHERE kind = 'usage'), 0) AS usage_charged_nanos,
                    COUNT(*) FILTER (WHERE kind = 'usage') AS requests
                 FROM market_ledger WHERE ${since} GROUP BY user_id ORDER BY paid_paise DESC, usage_charged_nanos DESC LIMIT 10`, p),
            this.db.query<any>(`SELECT COALESCE(SUM(balance_nanos), 0) AS nanos, COUNT(*) FILTER (WHERE balance_nanos > 0) AS wallets FROM market_wallets`),
            this.db.query<any>(
                `SELECT COALESCE(SUM(fee_paise), 0) AS fee_paise, COALESCE(SUM(paid_paise), 0) AS paid_paise,
                        COALESCE(-SUM(amount_nanos) FILTER (WHERE kind = 'usage'), 0) - COALESCE(SUM(upstream_nanos) FILTER (WHERE kind = 'usage'), 0) AS markup_nanos
                 FROM market_ledger`),
            this.db.query<any>(
                `SELECT COALESCE(provider, 'Unknown') AS provider, COUNT(*) AS requests, -SUM(amount_nanos) AS charged_nanos, SUM(upstream_nanos) AS upstream_nanos
                 FROM market_ledger WHERE ${since} AND kind = 'usage' GROUP BY 1 ORDER BY charged_nanos DESC`, p),
            this.db.query<any>(
                `SELECT provider, SUM(upstream_nanos) AS upstream_nanos FROM market_ledger
                 WHERE kind = 'usage' AND provider IS NOT NULL AND created_at > now() - interval '30 days' GROUP BY provider`),
        ]);
        return { totals: totals.rows[0], daily: daily.rows, models: models.rows, users: users.rows, liability: liability.rows[0], allTime: allTime.rows[0], providers: providers.rows, spend30: spend30.rows };
    }
}
