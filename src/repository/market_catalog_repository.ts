import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type ProviderKind = "openai_compatible" | "anthropic" | "openrouter";

export type ProviderRow = {
    id: string;
    name: string;
    kind: ProviderKind;
    base_url: string;
    api_key_enc: string;
    key_hint: string;
    region: string | null;
    priority: number;
    enabled: boolean;
    notes: string | null;
    budget_usd: string | null;
    last_synced_at: Date | null;
    sync_error: string | null;
    created_at: Date;
    updated_at: Date;
};

export type DiscoveredRow = {
    provider_id: string;
    upstream_model: string;
    input_per_m: string | null;
    output_per_m: string | null;
    context_length: number | null;
    status: "new" | "ignored" | "added";
    first_seen: Date;
    last_seen: Date;
};

export type DiscoveredInput = { upstream_model: string; input_per_m: number | null; output_per_m: number | null; context_length: number | null };

export type ModelRow = {
    id: string;
    name: string;
    author: string;
    description: string;
    context_length: number | null;
    max_output: number | null;
    input_modalities: string[];
    tools: boolean;
    reasoning: boolean;
    structured_output: boolean;
    released: Date | null;
    hugging_face_id: string | null;
    featured: boolean;
    india_hosted: boolean;
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
};

export type OfferRow = {
    id: string;
    model_id: string;
    provider_id: string;
    upstream_model: string;
    input_per_m: string;
    output_per_m: string;
    cache_read_per_m: string | null;
    request_price: string;
    markup_pct: string | null;
    context_length: number | null;
    max_output: number | null;
    quantization: string | null;
    priority: number;
    enabled: boolean;
    created_at: Date;
};

export type ProviderInput = Pick<ProviderRow, "name" | "kind" | "base_url" | "api_key_enc" | "key_hint" | "region" | "priority" | "enabled" | "notes"> & { budget_usd: number | null };
export type ModelInput = Omit<ModelRow, "created_at" | "updated_at">;
export type OfferInput = Omit<OfferRow, "id" | "created_at" | "input_per_m" | "output_per_m" | "cache_read_per_m" | "request_price" | "markup_pct"> & {
    input_per_m: number; output_per_m: number; cache_read_per_m: number | null; request_price: number; markup_pct: number | null;
};

// The owner's own catalogue: provider accounts, models and offers.
export class MarketCatalogRepository {
    constructor(private db: IDatabaseAdapter) {}

    // ── providers ──
    async providers(): Promise<ProviderRow[]> {
        return (await this.db.query<ProviderRow>(`SELECT * FROM market_providers ORDER BY priority, name`)).rows;
    }

    async provider(id: string): Promise<ProviderRow | null> {
        return (await this.db.query<ProviderRow>(`SELECT * FROM market_providers WHERE id = $1`, [id])).rows[0] ?? null;
    }

    async createProvider(id: string, p: ProviderInput): Promise<ProviderRow> {
        const { rows } = await this.db.query<ProviderRow>(
            `INSERT INTO market_providers (id, name, kind, base_url, api_key_enc, key_hint, region, priority, enabled, notes, budget_usd)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [id, p.name, p.kind, p.base_url, p.api_key_enc, p.key_hint, p.region, p.priority, p.enabled, p.notes, p.budget_usd],
        );
        return rows[0];
    }

    async updateProvider(id: string, p: ProviderInput): Promise<ProviderRow | null> {
        const { rows } = await this.db.query<ProviderRow>(
            `UPDATE market_providers SET name = $2, kind = $3, base_url = $4, api_key_enc = $5, key_hint = $6, region = $7,
                priority = $8, enabled = $9, notes = $10, budget_usd = $11, updated_at = now()
             WHERE id = $1 RETURNING *`,
            [id, p.name, p.kind, p.base_url, p.api_key_enc, p.key_hint, p.region, p.priority, p.enabled, p.notes, p.budget_usd],
        );
        return rows[0] ?? null;
    }

    async deleteProvider(id: string): Promise<boolean> {
        return (await this.db.query(`DELETE FROM market_providers WHERE id = $1`, [id])).rowCount > 0;
    }

    // ── models ──
    async models(): Promise<ModelRow[]> {
        return (await this.db.query<ModelRow>(`SELECT * FROM market_models ORDER BY featured DESC, name`)).rows;
    }

    async model(id: string): Promise<ModelRow | null> {
        return (await this.db.query<ModelRow>(`SELECT * FROM market_models WHERE id = $1`, [id])).rows[0] ?? null;
    }

    async upsertModel(m: ModelInput): Promise<ModelRow> {
        const { rows } = await this.db.query<ModelRow>(
            `INSERT INTO market_models (id, name, author, description, context_length, max_output, input_modalities, tools, reasoning,
                                        structured_output, released, hugging_face_id, featured, india_hosted, enabled)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, author = EXCLUDED.author, description = EXCLUDED.description,
                context_length = EXCLUDED.context_length, max_output = EXCLUDED.max_output, input_modalities = EXCLUDED.input_modalities,
                tools = EXCLUDED.tools, reasoning = EXCLUDED.reasoning, structured_output = EXCLUDED.structured_output,
                released = EXCLUDED.released, hugging_face_id = EXCLUDED.hugging_face_id, featured = EXCLUDED.featured,
                india_hosted = EXCLUDED.india_hosted, enabled = EXCLUDED.enabled, updated_at = now()
             RETURNING *`,
            [m.id, m.name, m.author, m.description, m.context_length, m.max_output, m.input_modalities, m.tools, m.reasoning,
                m.structured_output, m.released, m.hugging_face_id, m.featured, m.india_hosted, m.enabled],
        );
        return rows[0];
    }

    async deleteModel(id: string): Promise<boolean> {
        return (await this.db.query(`DELETE FROM market_models WHERE id = $1`, [id])).rowCount > 0;
    }

    // ── offers ──
    async offers(modelId?: string): Promise<OfferRow[]> {
        return modelId
            ? (await this.db.query<OfferRow>(`SELECT * FROM market_offers WHERE model_id = $1 ORDER BY priority, created_at`, [modelId])).rows
            : (await this.db.query<OfferRow>(`SELECT * FROM market_offers ORDER BY model_id, priority, created_at`)).rows;
    }

    async offer(id: string): Promise<OfferRow | null> {
        return (await this.db.query<OfferRow>(`SELECT * FROM market_offers WHERE id = $1`, [id])).rows[0] ?? null;
    }

    async createOffer(id: string, o: OfferInput): Promise<OfferRow> {
        const { rows } = await this.db.query<OfferRow>(
            `INSERT INTO market_offers (id, model_id, provider_id, upstream_model, input_per_m, output_per_m, cache_read_per_m, request_price,
                                        markup_pct, context_length, max_output, quantization, priority, enabled)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
            [id, o.model_id, o.provider_id, o.upstream_model, o.input_per_m, o.output_per_m, o.cache_read_per_m, o.request_price,
                o.markup_pct, o.context_length, o.max_output, o.quantization, o.priority, o.enabled],
        );
        return rows[0];
    }

    async updateOffer(id: string, o: OfferInput): Promise<OfferRow | null> {
        const { rows } = await this.db.query<OfferRow>(
            `UPDATE market_offers SET provider_id = $2, upstream_model = $3, input_per_m = $4, output_per_m = $5, cache_read_per_m = $6,
                request_price = $7, markup_pct = $8, context_length = $9, max_output = $10, quantization = $11, priority = $12, enabled = $13
             WHERE id = $1 RETURNING *`,
            [id, o.provider_id, o.upstream_model, o.input_per_m, o.output_per_m, o.cache_read_per_m, o.request_price, o.markup_pct,
                o.context_length, o.max_output, o.quantization, o.priority, o.enabled],
        );
        return rows[0] ?? null;
    }

    async deleteOffer(id: string): Promise<boolean> {
        return (await this.db.query(`DELETE FROM market_offers WHERE id = $1`, [id])).rowCount > 0;
    }

    // ── models discovered from providers (sync) ──
    // Records what a provider lists now. Names already sold are marked "added";
    // the rest stay "new" until the owner adds or ignores them.
    async upsertDiscovered(providerId: string, items: DiscoveredInput[], sold: Set<string>): Promise<number> {
        let fresh = 0;
        for (const it of items) {
            const { rows } = await this.db.query<{ inserted: boolean }>(
                `INSERT INTO market_discovered (provider_id, upstream_model, input_per_m, output_per_m, context_length, status)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (provider_id, upstream_model) DO UPDATE SET
                    input_per_m = COALESCE(EXCLUDED.input_per_m, market_discovered.input_per_m),
                    output_per_m = COALESCE(EXCLUDED.output_per_m, market_discovered.output_per_m),
                    context_length = COALESCE(EXCLUDED.context_length, market_discovered.context_length),
                    status = CASE WHEN $6 = 'added' THEN 'added' ELSE market_discovered.status END,
                    last_seen = now()
                 RETURNING (xmax = 0) AS inserted`,
                [providerId, it.upstream_model, it.input_per_m, it.output_per_m, it.context_length, sold.has(it.upstream_model) ? "added" : "new"],
            );
            if (rows[0]?.inserted && !sold.has(it.upstream_model)) fresh++;
        }
        return fresh;
    }

    async markSynced(providerId: string, error: string | null): Promise<void> {
        await this.db.query(
            error
                ? `UPDATE market_providers SET sync_error = $2 WHERE id = $1`
                : `UPDATE market_providers SET last_synced_at = now(), sync_error = NULL WHERE id = $1`,
            error ? [providerId, error.slice(0, 300)] : [providerId],
        );
    }

    async discovered(): Promise<DiscoveredRow[]> {
        return (await this.db.query<DiscoveredRow>(`SELECT * FROM market_discovered ORDER BY first_seen DESC, upstream_model`)).rows;
    }

    async setDiscoveredStatus(providerId: string, upstreamModel: string, status: DiscoveredRow["status"]): Promise<boolean> {
        return (await this.db.query(`UPDATE market_discovered SET status = $3 WHERE provider_id = $1 AND upstream_model = $2`, [providerId, upstreamModel, status])).rowCount > 0;
    }

    async ignoreAllNew(providerId: string): Promise<number> {
        return (await this.db.query(`UPDATE market_discovered SET status = 'ignored' WHERE provider_id = $1 AND status = 'new'`, [providerId])).rowCount;
    }

    // ── provider health (hourly buckets) ──
    async addStats(rows: { providerId: string; modelId: string; hour: Date; requests: number; errors: number; latencySum: number; latencyCount: number }[]): Promise<void> {
        for (const r of rows) {
            await this.db.query(
                `INSERT INTO market_provider_stats (provider_id, model_id, hour, requests, errors, latency_ms_sum, latency_count)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (provider_id, model_id, hour) DO UPDATE SET
                    requests = market_provider_stats.requests + EXCLUDED.requests,
                    errors = market_provider_stats.errors + EXCLUDED.errors,
                    latency_ms_sum = market_provider_stats.latency_ms_sum + EXCLUDED.latency_ms_sum,
                    latency_count = market_provider_stats.latency_count + EXCLUDED.latency_count`,
                [r.providerId, r.modelId, r.hour, r.requests, r.errors, Math.round(r.latencySum), r.latencyCount],
            );
        }
    }

    // Last 24 hours per provider and model.
    async stats24h(): Promise<{ provider_id: string; model_id: string; requests: number; errors: number; latency_ms_sum: string; latency_count: number }[]> {
        const { rows } = await this.db.query<any>(
            `SELECT provider_id, model_id, SUM(requests)::int AS requests, SUM(errors)::int AS errors,
                    SUM(latency_ms_sum) AS latency_ms_sum, SUM(latency_count)::int AS latency_count
             FROM market_provider_stats WHERE hour > now() - interval '24 hours'
             GROUP BY provider_id, model_id`,
        );
        return rows;
    }

    async pruneStats(days = 30): Promise<void> {
        await this.db.query(`DELETE FROM market_provider_stats WHERE hour < now() - make_interval(days => $1)`, [days]);
    }
}
