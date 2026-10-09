import { randomUUID } from "node:crypto";
import { MarketCatalogRepository, ModelInput, ModelRow, OfferInput, OfferRow, ProviderKind, ProviderRow } from "../../repository/market_catalog_repository";
import { decryptSecret, encryptSecret } from "../../service/agents/secrets";
import { assertPublicUrl } from "../../service/agents/url_guard";
import type { CatalogEndpoint, CatalogModel, Price } from "./catalog";
import { MarketConfig } from "./market_config";

// The owner's own catalogue: provider accounts (keys encrypted), the models
// sold, and offers (which provider serves which model at what upstream
// price). Cached briefly; every admin change refreshes it.

const TTL_MS = 30_000;
const MODEL_ID = /^[a-z0-9][\w.\-]*\/[\w.:\-]+$/i;

// Presets for the provider form (all OpenAI-compatible unless noted).
export const PROVIDER_PRESETS: { id: string; name: string; kind: ProviderKind; baseUrl: string; keysUrl: string }[] = [
    { id: "openai", name: "OpenAI", kind: "openai_compatible", baseUrl: "https://api.openai.com/v1", keysUrl: "https://platform.openai.com/api-keys" },
    { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", keysUrl: "https://console.anthropic.com/settings/keys" },
    { id: "google", name: "Google AI Studio", kind: "openai_compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keysUrl: "https://aistudio.google.com/apikey" },
    { id: "deepinfra", name: "DeepInfra", kind: "openai_compatible", baseUrl: "https://api.deepinfra.com/v1/openai", keysUrl: "https://deepinfra.com/dash/api_keys" },
    { id: "together", name: "Together AI", kind: "openai_compatible", baseUrl: "https://api.together.xyz/v1", keysUrl: "https://api.together.ai/settings/api-keys" },
    { id: "groq", name: "Groq", kind: "openai_compatible", baseUrl: "https://api.groq.com/openai/v1", keysUrl: "https://console.groq.com/keys" },
    { id: "fireworks", name: "Fireworks AI", kind: "openai_compatible", baseUrl: "https://api.fireworks.ai/inference/v1", keysUrl: "https://fireworks.ai/account/api-keys" },
    { id: "mistral", name: "Mistral", kind: "openai_compatible", baseUrl: "https://api.mistral.ai/v1", keysUrl: "https://console.mistral.ai/api-keys" },
    { id: "deepseek", name: "DeepSeek", kind: "openai_compatible", baseUrl: "https://api.deepseek.com/v1", keysUrl: "https://platform.deepseek.com/api_keys" },
    { id: "openrouter", name: "OpenRouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", keysUrl: "https://openrouter.ai/keys" },
];

export class CatalogError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

export type OfferPrices = { inputPerM: number; outputPerM: number; cacheReadPerM: number | null; request: number; markupPct: number | null };

export type OwnOffer = { offer: OfferRow; provider: ProviderRow; prices: OfferPrices };

type State = { at: number; providers: Map<string, ProviderRow>; models: ModelRow[]; offers: OfferRow[] };

const num = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
};
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const hint = (key: string) => (key.length > 8 ? `••••${key.slice(-4)}` : "••••");

export const offerPrices = (o: OfferRow): OfferPrices => ({
    inputPerM: num(o.input_per_m),
    outputPerM: num(o.output_per_m),
    cacheReadPerM: o.cache_read_per_m === null ? null : num(o.cache_read_per_m),
    request: num(o.request_price),
    markupPct: o.markup_pct === null ? null : num(o.markup_pct),
});

export class OwnCatalog {
    private state: State | null = null;
    private loading: Promise<State> | null = null;
    private keys = new Map<string, { stamp: number; key: string }>();
    private hasRoutes = false;
    // Set by the router: live status per provider id for the Models page.
    statusOf: (providerId: string, modelId?: string) => { status: "up" | "degraded" | "down"; uptime: number | null; latencyMs?: number | null } = () => ({ status: "up", uptime: null });

    constructor(private repo: MarketCatalogRepository, private cfg: () => MarketConfig) {}

    // True when at least one model can be served by an enabled provider.
    get ready(): boolean { return this.hasRoutes; }

    invalidate() { this.state = null; }

    // Reloads now (after an admin change), so routing and `ready` are current at once.
    private async refresh() {
        this.state = null;
        await this.load();
    }

    private async load(): Promise<State> {
        if (this.state && Date.now() - this.state.at < TTL_MS) return this.state;
        this.loading ??= Promise.all([this.repo.providers(), this.repo.models(), this.repo.offers()])
            .then(([providers, models, offers]) => {
                const state = { at: Date.now(), providers: new Map(providers.map((p) => [p.id, p])), models, offers };
                this.state = state;
                this.hasRoutes = offers.some((o) => o.enabled && state.providers.get(o.provider_id)?.enabled && models.find((m) => m.id === o.model_id)?.enabled);
                return state;
            })
            .finally(() => { this.loading = null; });
        return this.loading;
    }

    // Enabled offers for a model, on enabled providers, in routing order (priority, then price).
    async offersFor(modelId: string): Promise<OwnOffer[]> {
        const s = await this.load();
        const model = s.models.find((m) => m.id === modelId);
        if (!model?.enabled) return [];
        return s.offers
            .filter((o) => o.model_id === modelId && o.enabled && s.providers.get(o.provider_id)?.enabled)
            .map((o) => ({ offer: o, provider: s.providers.get(o.provider_id)!, prices: offerPrices(o) }))
            .sort((a, b) => (a.offer.priority - b.offer.priority) || (a.provider.priority - b.provider.priority)
                || (a.prices.inputPerM + a.prices.outputPerM) - (b.prices.inputPerM + b.prices.outputPerM));
    }

    apiKey(p: ProviderRow): string {
        const stamp = new Date(p.updated_at).getTime();
        const hit = this.keys.get(p.id);
        if (hit && hit.stamp === stamp) return hit.key;
        const key = decryptSecret(p.api_key_enc);
        this.keys.set(p.id, { stamp, key });
        return key;
    }

    private userPrice(p: OfferPrices): Price {
        const m = 1 + (p.markupPct ?? this.cfg().usageMarkupPct) / 100;
        return {
            input: r6(p.inputPerM * m),
            output: r6(p.outputPerM * m),
            cacheRead: p.cacheReadPerM === null ? null : r6(p.cacheReadPerM * m),
            request: r6(p.request * m),
            image: null,
        };
    }

    // The sellable models, as marketplace catalogue entries (priced from the cheapest offer).
    async models(): Promise<CatalogModel[]> {
        const s = await this.load();
        const out: CatalogModel[] = [];
        for (const m of s.models) {
            if (!m.enabled) continue;
            const offers = await this.offersFor(m.id);
            if (!offers.length) continue;
            const cheapest = [...offers].sort((a, b) => (a.prices.inputPerM + a.prices.outputPerM) - (b.prices.inputPerM + b.prices.outputPerM))[0];
            const price = this.userPrice(cheapest.prices);
            out.push({
                id: m.id,
                name: m.name,
                author: m.author,
                description: m.description,
                created: m.released ? Math.floor(new Date(m.released).getTime() / 1000) : Math.floor(new Date(m.created_at).getTime() / 1000),
                contextLength: m.context_length,
                maxOutput: m.max_output,
                inputModalities: m.input_modalities?.length ? m.input_modalities : ["text"],
                outputModalities: ["text"],
                tools: m.tools,
                reasoning: m.reasoning,
                structuredOutput: m.structured_output,
                free: price.input === 0 && price.output === 0 && price.request === 0,
                huggingFaceId: m.hugging_face_id,
                price,
                upstream: {
                    prompt: cheapest.prices.inputPerM / 1e6,
                    completion: cheapest.prices.outputPerM / 1e6,
                    cacheRead: (cheapest.prices.cacheReadPerM ?? cheapest.prices.inputPerM) / 1e6,
                    request: cheapest.prices.request,
                },
                source: "own",
                featured: m.featured,
                indiaHosted: m.india_hosted,
            });
        }
        return out;
    }

    // The providers serving one of the owner's models (null if it isn't one).
    async endpoints(modelId: string): Promise<CatalogEndpoint[] | null> {
        const s = await this.load();
        if (!s.models.some((m) => m.id === modelId && m.enabled)) return null;
        return (await this.offersFor(modelId)).map(({ offer, provider, prices }) => {
            const health = this.statusOf(provider.id, modelId);
            return {
                provider: provider.name,
                tag: provider.region ? provider.region : null,
                quantization: offer.quantization,
                contextLength: offer.context_length,
                maxOutput: offer.max_output,
                price: this.userPrice(prices),
                tools: s.models.find((m) => m.id === modelId)?.tools ?? false,
                uptime1d: health.uptime,
                latencyMs: health.latencyMs ?? null,
                status: health.status,
            };
        });
    }

    // ── owner admin ──
    async adminView() {
        const s = await this.load();
        return {
            providers: [...s.providers.values()].map(providerDto),
            models: s.models.map((m) => ({ ...modelDto(m), offers: s.offers.filter((o) => o.model_id === m.id).map(offerDto) })),
            presets: PROVIDER_PRESETS,
        };
    }

    async saveProvider(id: string | null, body: any) {
        const existing = id ? await this.repo.provider(id) : null;
        if (id && !existing) throw new CatalogError("Provider not found", 404);
        const name = String(body?.name ?? existing?.name ?? "").trim().slice(0, 60);
        if (!name) throw new CatalogError("Give the provider a name, e.g. \"DeepInfra\"");
        const taken = (await this.repo.providers()).some((p) => p.id !== existing?.id && p.name.toLowerCase() === name.toLowerCase());
        if (taken) throw new CatalogError(`You already have a provider named "${name}"`, 409);
        const kind = String(body?.kind ?? existing?.kind ?? "openai_compatible") as ProviderKind;
        if (!["openai_compatible", "anthropic", "openrouter"].includes(kind)) throw new CatalogError("Unknown provider type");
        const baseUrl = await validBaseUrl(body?.baseUrl ?? existing?.base_url);
        const rawKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
        if (rawKey && (rawKey.length > 500 || /\s/.test(rawKey))) throw new CatalogError("That doesn't look like an API key");
        if (!rawKey && !existing) throw new CatalogError("Paste the provider's API key");
        const input = {
            name,
            kind,
            base_url: baseUrl,
            api_key_enc: rawKey ? encryptSecret(rawKey) : existing!.api_key_enc,
            key_hint: rawKey ? hint(rawKey) : existing!.key_hint,
            region: typeof body?.region === "string" ? body.region.trim().slice(0, 40) || null : existing?.region ?? null,
            priority: Number.isFinite(Number(body?.priority)) ? Math.round(Number(body.priority)) : existing?.priority ?? 100,
            enabled: typeof body?.enabled === "boolean" ? body.enabled : existing?.enabled ?? true,
            notes: typeof body?.notes === "string" ? body.notes.trim().slice(0, 300) || null : existing?.notes ?? null,
            budget_usd: budgetOf(body?.budgetUsd, existing?.budget_usd ?? null),
        };
        try {
            const row = existing ? await this.repo.updateProvider(existing.id, input) : await this.repo.createProvider(randomUUID(), input);
            await this.refresh();
            return providerDto(row!);
        } catch (err: any) {
            if (err?.code === "23505") throw new CatalogError(`You already have a provider named "${name}"`, 409);
            throw err;
        }
    }

    async deleteProvider(id: string) {
        if (!(await this.repo.deleteProvider(id))) throw new CatalogError("Provider not found", 404);
        await this.refresh();
    }

    // Lists a provider's models (to pick upstream model names) — also proves the key works.
    async testProvider(id: string): Promise<{ ok: true; models: string[] }> {
        const p = await this.repo.provider(id);
        if (!p) throw new CatalogError("Provider not found", 404);
        await assertPublicUrl(p.base_url).catch((e) => { throw new CatalogError(e instanceof Error ? e.message : "That address isn't allowed"); });
        const key = this.apiKey(p);
        const headers: Record<string, string> = p.kind === "anthropic"
            ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
            : { Authorization: `Bearer ${key}` };
        const res = await fetch(`${p.base_url}/models`, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (!res) throw new CatalogError("Couldn't reach the provider — check the base URL.", 502);
        if (res.status === 401 || res.status === 403) throw new CatalogError(`The provider rejected the API key (${res.status}).`, 502);
        if (!res.ok) throw new CatalogError(`The provider answered ${res.status} — check the base URL.`, 502);
        const json: any = await res.json().catch(() => ({}));
        const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
        const models = [...new Set<string>(list.map((m: any) => String(m?.id ?? m?.name ?? "").replace(/^models\//, "")).filter(Boolean))].sort().slice(0, 2000);
        return { ok: true, models };
    }

    async saveModel(body: any, prefill?: Partial<CatalogModel> | null) {
        const id = String(body?.id ?? "").trim();
        if (!MODEL_ID.test(id) || id.length > 120) throw new CatalogError("Model id must look like \"maker/model-name\", e.g. \"qwen/qwen3-32b\"");
        const existing = await this.repo.model(id);
        const pick = <T>(key: string, fallback: T): T => (body?.[key] !== undefined ? body[key] : fallback);
        const int = (v: unknown) => (v === null || v === "" || v === undefined ? null : Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
        const input: ModelInput = {
            id,
            name: String(pick("name", existing?.name ?? prefill?.name ?? id)).trim().slice(0, 120) || id,
            author: String(pick("author", existing?.author ?? prefill?.author ?? id.split("/")[0])).trim().slice(0, 60) || id.split("/")[0],
            description: String(pick("description", existing?.description ?? prefill?.description ?? "")).slice(0, 2000),
            context_length: int(pick("contextLength", existing?.context_length ?? prefill?.contextLength ?? null)),
            max_output: int(pick("maxOutput", existing?.max_output ?? prefill?.maxOutput ?? null)),
            input_modalities: Array.isArray(body?.inputModalities)
                ? body.inputModalities.filter((x: unknown) => ["text", "image", "file", "audio"].includes(String(x))).map(String)
                : existing?.input_modalities ?? prefill?.inputModalities ?? ["text"],
            tools: Boolean(pick("tools", existing?.tools ?? prefill?.tools ?? false)),
            reasoning: Boolean(pick("reasoning", existing?.reasoning ?? prefill?.reasoning ?? false)),
            structured_output: Boolean(pick("structuredOutput", existing?.structured_output ?? prefill?.structuredOutput ?? false)),
            released: body?.released ? new Date(String(body.released)) : existing?.released ?? (prefill?.created ? new Date(prefill.created * 1000) : null),
            hugging_face_id: String(pick("huggingFaceId", existing?.hugging_face_id ?? prefill?.huggingFaceId ?? "") ?? "").trim().slice(0, 200) || null,
            featured: Boolean(pick("featured", existing?.featured ?? false)),
            india_hosted: Boolean(pick("indiaHosted", existing?.india_hosted ?? false)),
            enabled: Boolean(pick("enabled", existing?.enabled ?? true)),
        };
        if (input.released && Number.isNaN(input.released.getTime())) input.released = null;
        const row = await this.repo.upsertModel(input);
        await this.refresh();
        return modelDto(row);
    }

    async deleteModel(id: string) {
        if (!(await this.repo.deleteModel(id))) throw new CatalogError("Model not found", 404);
        await this.refresh();
    }

    async saveOffer(id: string | null, body: any) {
        const existing = id ? await this.repo.offer(id) : null;
        if (id && !existing) throw new CatalogError("Offer not found", 404);
        const modelId = String(existing?.model_id ?? body?.modelId ?? "");
        if (!(await this.repo.model(modelId))) throw new CatalogError("Add the model first");
        const providerId = String(body?.providerId ?? existing?.provider_id ?? "");
        if (!(await this.repo.provider(providerId))) throw new CatalogError("Choose a provider");
        const upstream = String(body?.upstreamModel ?? existing?.upstream_model ?? "").trim();
        if (!upstream || upstream.length > 200 || /\s/.test(upstream)) throw new CatalogError("Enter the provider's model name, e.g. \"Qwen/Qwen3-32B\"");
        const price = (key: string, fallback: number | null, required = true) => {
            const v = body?.[key] ?? fallback;
            if (v === null || v === "" || v === undefined) {
                if (required) throw new CatalogError("Enter the provider's input and output price per 1M tokens (0 for free)");
                return null;
            }
            const x = Number(v);
            if (!Number.isFinite(x) || x < 0 || x > 10_000) throw new CatalogError("Prices must be between 0 and 10,000 USD per 1M tokens");
            return x;
        };
        const markup = body?.markupPct === "" || body?.markupPct === null ? null : body?.markupPct ?? (existing?.markup_pct === null || existing?.markup_pct === undefined ? null : num(existing.markup_pct));
        if (markup !== null && (!Number.isFinite(Number(markup)) || Number(markup) < 0 || Number(markup) > 500)) throw new CatalogError("Markup must be between 0 and 500%");
        const int = (v: unknown, f: number | null) => (v === undefined ? f : v === null || v === "" ? null : Math.max(1, Math.round(Number(v))) || null);
        const input: OfferInput = {
            model_id: modelId,
            provider_id: providerId,
            upstream_model: upstream,
            input_per_m: price("inputPerM", existing ? num(existing.input_per_m) : null)!,
            output_per_m: price("outputPerM", existing ? num(existing.output_per_m) : null)!,
            cache_read_per_m: price("cacheReadPerM", existing?.cache_read_per_m === null || existing?.cache_read_per_m === undefined ? null : num(existing.cache_read_per_m), false),
            request_price: price("requestPrice", existing ? num(existing.request_price) : 0, false) ?? 0,
            markup_pct: markup === null ? null : Number(markup),
            context_length: int(body?.contextLength, existing?.context_length ?? null),
            max_output: int(body?.maxOutput, existing?.max_output ?? null),
            quantization: body?.quantization !== undefined ? String(body.quantization ?? "").trim().slice(0, 20) || null : existing?.quantization ?? null,
            priority: Number.isFinite(Number(body?.priority)) ? Math.round(Number(body.priority)) : existing?.priority ?? 100,
            enabled: typeof body?.enabled === "boolean" ? body.enabled : existing?.enabled ?? true,
        };
        try {
            const row = existing ? await this.repo.updateOffer(existing.id, input) : await this.repo.createOffer(randomUUID(), input);
            // A discovered name now sold: off the Discover list.
            await this.repo.setDiscoveredStatus(providerId, upstream, "added").catch(() => false);
            await this.refresh();
            return offerDto(row!);
        } catch (err: any) {
            if (err?.code === "23505") throw new CatalogError("This provider already offers that model under the same name", 409);
            throw err;
        }
    }

    async deleteOffer(id: string) {
        if (!(await this.repo.deleteOffer(id))) throw new CatalogError("Offer not found", 404);
        await this.refresh();
    }
}

// Optional monthly spend alert for a provider (USD); "" / null clears it.
function budgetOf(raw: unknown, fallback: string | null): number | null {
    if (raw === undefined) return fallback === null ? null : Number(fallback);
    if (raw === null || raw === "") return null;
    const x = Number(raw);
    if (!Number.isFinite(x) || x <= 0 || x > 1_000_000) throw new CatalogError("Monthly budget must be a positive amount in USD (or empty)");
    return Math.round(x * 100) / 100;
}

async function validBaseUrl(raw: unknown): Promise<string> {
    const value = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
    if (!value) throw new CatalogError("Enter the provider's base URL");
    if (value.length > 300) throw new CatalogError("Base URL is too long");
    let url: URL;
    try {
        url = await assertPublicUrl(value);
    } catch (err) {
        throw new CatalogError(err instanceof Error ? err.message : "That URL isn't allowed");
    }
    if (url.protocol !== "https:" && process.env.AGENT_ALLOW_PRIVATE_URLS !== "true") throw new CatalogError("Use an https:// address so the key is sent encrypted");
    return value;
}

function providerDto(p: ProviderRow) {
    return {
        id: p.id, name: p.name, kind: p.kind, baseUrl: p.base_url, keyHint: p.key_hint, region: p.region, priority: p.priority, enabled: p.enabled, notes: p.notes,
        budgetUsd: p.budget_usd === null || p.budget_usd === undefined ? null : Number(p.budget_usd),
        lastSyncedAt: p.last_synced_at ?? null, syncError: p.sync_error ?? null, updatedAt: p.updated_at,
    };
}

function modelDto(m: ModelRow) {
    return {
        id: m.id, name: m.name, author: m.author, description: m.description, contextLength: m.context_length, maxOutput: m.max_output,
        inputModalities: m.input_modalities, tools: m.tools, reasoning: m.reasoning, structuredOutput: m.structured_output,
        released: m.released, huggingFaceId: m.hugging_face_id, featured: m.featured, indiaHosted: m.india_hosted, enabled: m.enabled,
    };
}

function offerDto(o: OfferRow) {
    const p = offerPrices(o);
    return {
        id: o.id, modelId: o.model_id, providerId: o.provider_id, upstreamModel: o.upstream_model,
        inputPerM: p.inputPerM, outputPerM: p.outputPerM, cacheReadPerM: p.cacheReadPerM, requestPrice: p.request, markupPct: p.markupPct,
        contextLength: o.context_length, maxOutput: o.max_output, quantization: o.quantization, priority: o.priority, enabled: o.enabled,
    };
}
