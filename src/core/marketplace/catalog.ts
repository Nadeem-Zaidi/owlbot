import { MarketConfig } from "./market_config";
import { OpenRouterClient, OREndpoint, ORModel } from "./openrouter";
import type { OwnCatalog } from "./own_catalog";

// The model catalogue shown in the marketplace: the owner's own models
// (own provider accounts) first, then — as a fallback, or when there's no
// own catalogue yet — OpenRouter's public list. Prices are what Owl Bot
// users pay (upstream × markup), per million tokens in USD.

const MODELS_TTL_MS = 60 * 60 * 1000;
const ENDPOINTS_TTL_MS = 10 * 60 * 1000;
const MODEL_ID = /^[\w.\-]+\/[\w.:\-]+$/;

export type Price = { input: number; output: number; cacheRead: number | null; request: number; image: number | null };

export type CatalogModel = {
    id: string;
    name: string;
    author: string;
    description: string;
    created: number | null;
    contextLength: number | null;
    maxOutput: number | null;
    inputModalities: string[];
    outputModalities: string[];
    tools: boolean;
    reasoning: boolean;
    structuredOutput: boolean;
    free: boolean;
    huggingFaceId: string | null;
    // Per 1M tokens (per request for `request`), USD — the price users pay.
    price: Price;
    // Upstream per-token USD prices, for estimating usage cost.
    upstream: { prompt: number; completion: number; cacheRead: number; request: number };
    source?: "own" | "openrouter";
    featured?: boolean;
    indiaHosted?: boolean;
};

export type CatalogEndpoint = {
    provider: string;
    tag: string | null;
    quantization: string | null;
    contextLength: number | null;
    maxOutput: number | null;
    price: Price;
    tools: boolean;
    uptime1d: number | null;
    latencyMs?: number | null;
    status: "up" | "degraded" | "down";
};

const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : 0;
};

export const isModelId = (id: string) => id.length <= 200 && (MODEL_ID.test(id) || id === "openrouter/auto");

export class Catalog {
    private models: { at: number; list: CatalogModel[]; byId: Map<string, CatalogModel> } | null = null;
    private loading: Promise<void> | null = null;
    private endpointCache = new Map<string, { at: number; list: CatalogEndpoint[] }>();

    private own: OwnCatalog | null = null;

    constructor(private client: OpenRouterClient, private cfg: () => MarketConfig) {}

    setOwn(own: OwnCatalog) { this.own = own; }

    // OpenRouter's models are listed when there's no own catalogue yet, or as the fallback.
    private async useOpenRouter(ownCount: number): Promise<boolean> {
        return ownCount === 0 || (this.cfg().openrouterFallback && this.client.configured);
    }

    private price(p: Record<string, unknown> | undefined): Price {
        const m = 1 + this.cfg().usageMarkupPct / 100;
        const per1M = (v: unknown) => n(v) * 1_000_000 * m;
        return {
            input: round(per1M(p?.prompt)),
            output: round(per1M(p?.completion)),
            cacheRead: p?.input_cache_read !== undefined ? round(per1M(p.input_cache_read)) : null,
            request: round(n(p?.request) * m),
            image: p?.image !== undefined && n(p.image) > 0 ? round(n(p.image) * m) : null,
        };
    }

    private normalize(m: ORModel): CatalogModel {
        const params = m.supported_parameters ?? [];
        const p = m.pricing ?? {};
        const free = m.id.endsWith(":free") || (n(p.prompt) === 0 && n(p.completion) === 0 && n(p.request) === 0);
        return {
            id: m.id,
            name: m.name || m.id,
            author: m.id.split("/")[0],
            description: (m.description ?? "").slice(0, 1200),
            created: m.created ?? null,
            contextLength: m.context_length ?? m.top_provider?.context_length ?? null,
            maxOutput: m.top_provider?.max_completion_tokens ?? null,
            inputModalities: m.architecture?.input_modalities ?? ["text"],
            outputModalities: m.architecture?.output_modalities ?? ["text"],
            tools: params.includes("tools"),
            reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
            structuredOutput: params.includes("structured_outputs") || params.includes("response_format"),
            free,
            huggingFaceId: m.hugging_face_id ?? null,
            price: this.price(p),
            upstream: { prompt: n(p.prompt), completion: n(p.completion), cacheRead: n(p.input_cache_read), request: n(p.request) },
            source: "openrouter",
        };
    }

    // The full catalogue: own models, then OpenRouter's (not overriding own ids).
    async list(): Promise<CatalogModel[]> {
        const own = this.own ? await this.own.models() : [];
        let or: CatalogModel[] = [];
        if (await this.useOpenRouter(own.length)) {
            try { or = await this.openRouterList(); } catch (err) { if (!own.length) throw err; }
        }
        if (!own.length) return or;
        const ids = new Set(own.map((m) => m.id));
        return [...own, ...or.filter((m) => !ids.has(m.id))];
    }

    // OpenRouter's catalogue (cached for an hour; a failed refresh keeps the old copy).
    private async openRouterList(): Promise<CatalogModel[]> {
        if (this.models && Date.now() - this.models.at < MODELS_TTL_MS) return this.models.list;
        this.loading ??= this.client.models()
            .then((raw) => {
                const list = raw.filter((m) => m?.id && isModelId(m.id) && !m.expiration_date).map((m) => this.normalize(m));
                list.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
                this.models = { at: Date.now(), list, byId: new Map(list.map((m) => [m.id, m])) };
            })
            .catch((err) => {
                if (!this.models) throw err;
                console.warn("[marketplace] couldn't refresh the model list, keeping the cached one:", err instanceof Error ? err.message : err);
            })
            .finally(() => { this.loading = null; });
        await this.loading;
        return this.models!.list;
    }

    async get(id: string): Promise<CatalogModel | null> {
        if (!isModelId(id)) return null;
        const own = this.own ? await this.own.models() : [];
        const mine = own.find((m) => m.id === id);
        if (mine) return mine;
        if (!(await this.useOpenRouter(own.length))) return null;
        await this.openRouterList().catch(() => null);
        return this.models?.byId.get(id) ?? null;
    }

    // A model's details from OpenRouter's public list (to prefill the owner's own entry).
    async openRouterModel(id: string): Promise<CatalogModel | null> {
        await this.openRouterList().catch(() => null);
        return this.models?.byId.get(id) ?? null;
    }

    // Whether OpenRouter lists a model (for routing to it as a fallback).
    async openRouterHas(id: string): Promise<boolean> {
        await this.openRouterList().catch(() => null);
        return !!this.models?.byId.has(id);
    }

    // The providers serving a model, cheapest first.
    async endpoints(id: string): Promise<CatalogEndpoint[]> {
        const mine = this.own ? await this.own.endpoints(id) : null;
        if (mine) return mine;
        const hit = this.endpointCache.get(id);
        if (hit && Date.now() - hit.at < ENDPOINTS_TTL_MS) return hit.list;
        const raw = await this.client.endpoints(id);
        const list = raw.map((e: OREndpoint): CatalogEndpoint => ({
            provider: e.provider_name,
            tag: e.tag ?? null,
            quantization: e.quantization && e.quantization !== "unknown" ? e.quantization : null,
            contextLength: e.context_length ?? null,
            maxOutput: e.max_completion_tokens ?? null,
            price: this.price(e.pricing),
            tools: (e.supported_parameters ?? []).includes("tools"),
            uptime1d: typeof e.uptime_last_1d === "number" ? Math.round(e.uptime_last_1d * 10) / 10 : null,
            status: e.status === undefined || e.status === 0 ? "up" : e.status > -3 ? "degraded" : "down",
        })).sort((a, b) => a.price.input + a.price.output - (b.price.input + b.price.output));
        this.endpointCache.set(id, { at: Date.now(), list });
        if (this.endpointCache.size > 500) this.endpointCache.delete(this.endpointCache.keys().next().value!);
        return list;
    }

    // Estimated upstream USD cost of a call from its token counts (used when
    // OpenRouter's exact cost isn't available).
    estimateUsd(model: CatalogModel | null, input: number, output: number, cacheRead = 0): number {
        if (!model) return 0;
        const u = model.upstream;
        return (input * u.prompt) + (output * u.completion) + (cacheRead * (u.cacheRead || u.prompt)) + u.request;
    }
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
