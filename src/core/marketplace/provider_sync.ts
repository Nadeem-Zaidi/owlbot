import { MarketCatalogRepository, ProviderRow } from "../../repository/market_catalog_repository";
import { assertPublicUrl } from "../../service/agents/url_guard";
import { huggingFaceInfo, isHfId } from "./huggingface";
import { CatalogError, OwnCatalog } from "./own_catalog";
import type { Catalog } from "./catalog";

// Keeps the catalogue in step with what providers offer: a nightly sync (and
// "Sync now") reads each provider's model list. New names go to the owner's
// Discover list to add or ignore; models a provider stopped listing are
// flagged on their offers.

const SYNC_EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_SYNC_DELAY_MS = 2 * 60 * 1000;
// Not chat models: skipped.
const NOT_CHAT = /(embed|whisper|tts|speech|transcri|dall-?e|image-gen|imagen|flux|stable-diffusion|sdxl|moderation|rerank|realtime|audio|davinci|babbage|search|similarity|guard|clip)/i;

type ListedModel = { id: string; inputPerM: number | null; outputPerM: number | null; contextLength: number | null };

const num = (v: unknown): number | null => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : null;
};

// Prices and context from a provider's model list, where it includes them
// (OpenRouter-style per-token prices, or per-1M fields used by some hosts).
export function parseListedModel(m: any): ListedModel | null {
    const id = String(m?.id ?? m?.name ?? "").replace(/^models\//, "").trim();
    if (!id || id.length > 200 || /\s/.test(id)) return null;
    let inputPerM: number | null = null, outputPerM: number | null = null;
    const p = m?.pricing ?? m?.metadata?.pricing;
    if (p && typeof p === "object") {
        if (p.prompt !== undefined || p.completion !== undefined) {
            const a = num(p.prompt), b = num(p.completion);
            inputPerM = a === null ? null : Math.round(a * 1e6 * 1e6) / 1e6;
            outputPerM = b === null ? null : Math.round(b * 1e6 * 1e6) / 1e6;
        } else {
            inputPerM = num(p.input ?? p.input_tokens ?? p.input_per_million);
            outputPerM = num(p.output ?? p.output_tokens ?? p.output_per_million);
        }
    }
    const contextLength = num(m?.context_length ?? m?.context_window ?? m?.max_context_length ?? m?.metadata?.context_length ?? m?.inputTokenLimit);
    return { id, inputPerM, outputPerM, contextLength: contextLength ? Math.round(contextLength) : null };
}

// A marketplace id suggested for a provider's model name: "Qwen/Qwen3-32B" → "qwen/qwen3-32b",
// "gpt-4o-mini" → "openai/gpt-4o-mini".
export function suggestModelId(upstream: string, providerName: string): string {
    const clean = upstream.toLowerCase().replace(/^models\//, "").replace(/[^\w.:/\-]+/g, "-");
    if (clean.includes("/")) return clean.split("/").slice(-2).join("/");
    const makers: [RegExp, string][] = [
        [/^(gpt|o\d|chatgpt)/, "openai"], [/^claude/, "anthropic"], [/^(gemini|gemma)/, "google"], [/^(llama|meta-llama)/, "meta-llama"],
        [/^(mistral|mixtral|ministral|magistral|codestral|pixtral)/, "mistralai"], [/^(qwen|qwq)/, "qwen"], [/^deepseek/, "deepseek"],
        [/^grok/, "x-ai"], [/^(command|aya)/, "cohere"], [/^phi/, "microsoft"], [/^(sarvam)/, "sarvamai"],
    ];
    const maker = makers.find(([re]) => re.test(clean))?.[1] ?? providerName.toLowerCase().replace(/[^\w.\-]+/g, "-");
    return `${maker}/${clean}`;
}

export class ProviderSync {
    private timer: NodeJS.Timeout | null = null;
    private running: Promise<unknown> | null = null;

    constructor(private repo: MarketCatalogRepository, private own: OwnCatalog, private catalog: Catalog) {}

    // Nightly, on the server that runs background jobs.
    start() {
        const first = setTimeout(() => void this.syncAll(), FIRST_SYNC_DELAY_MS);
        first.unref?.();
        this.timer = setInterval(() => void this.syncAll(), SYNC_EVERY_MS);
        this.timer.unref?.();
    }

    stop() { if (this.timer) clearInterval(this.timer); }

    async syncAll(): Promise<{ provider: string; models?: number; added?: number; error?: string }[]> {
        if (this.running) return this.running as Promise<any>;
        const run = (async () => {
            const out: { provider: string; models?: number; added?: number; error?: string }[] = [];
            for (const p of await this.repo.providers()) {
                if (!p.enabled) continue;
                try {
                    const r = await this.syncProvider(p);
                    out.push({ provider: p.name, models: r.models, added: r.fresh });
                } catch (err) {
                    out.push({ provider: p.name, error: err instanceof Error ? err.message : String(err) });
                }
            }
            this.own.invalidate();
            return out;
        })();
        this.running = run.finally(() => { this.running = null; });
        return run;
    }

    private async list(p: ProviderRow): Promise<ListedModel[]> {
        await assertPublicUrl(p.base_url);
        const key = this.own.apiKey(p);
        const headers: Record<string, string> = p.kind === "anthropic"
            ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
            : { Authorization: `Bearer ${key}` };
        const res = await fetch(`${p.base_url.replace(/\/+$/, "")}/models${p.kind === "anthropic" ? "?limit=1000" : ""}`, { headers, signal: AbortSignal.timeout(30_000) });
        if (res.status === 401 || res.status === 403) throw new Error(`The provider rejected the API key (${res.status})`);
        if (!res.ok) throw new Error(`The provider answered ${res.status}`);
        const json: any = await res.json();
        const items = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
        return items.map(parseListedModel).filter((m: ListedModel | null): m is ListedModel => !!m && !NOT_CHAT.test(m.id)).slice(0, 3000);
    }

    async syncProvider(p: ProviderRow): Promise<{ models: number; fresh: number }> {
        try {
            const listed = await this.list(p);
            const sold = new Set((await this.repo.offers()).filter((o) => o.provider_id === p.id).map((o) => o.upstream_model));
            const fresh = await this.repo.upsertDiscovered(p.id, listed.map((m) => ({ upstream_model: m.id, input_per_m: m.inputPerM, output_per_m: m.outputPerM, context_length: m.contextLength })), sold);
            await this.repo.markSynced(p.id, null);
            return { models: listed.length, fresh };
        } catch (err) {
            await this.repo.markSynced(p.id, err instanceof Error ? err.message : String(err)).catch(() => {});
            throw err;
        }
    }

    async syncOne(providerId: string) {
        const p = await this.repo.provider(providerId);
        if (!p) throw new CatalogError("Provider not found", 404);
        const r = await this.syncProvider(p).catch((err) => { throw new CatalogError(err instanceof Error ? err.message : "Sync failed", 502); });
        this.own.invalidate();
        return r;
    }

    // The Discover list: new names per provider, with a suggested marketplace id.
    async view() {
        const [rows, providers, models] = await Promise.all([this.repo.discovered(), this.repo.providers(), this.repo.models()]);
        const byId = new Map(providers.map((p) => [p.id, p]));
        const modelIds = new Set(models.map((m) => m.id));
        return rows.filter((r) => r.status === "new" && byId.has(r.provider_id)).map((r) => {
            const suggested = suggestModelId(r.upstream_model, byId.get(r.provider_id)!.name);
            return {
                providerId: r.provider_id,
                providerName: byId.get(r.provider_id)!.name,
                upstreamModel: r.upstream_model,
                inputPerM: r.input_per_m === null ? null : Number(r.input_per_m),
                outputPerM: r.output_per_m === null ? null : Number(r.output_per_m),
                contextLength: r.context_length,
                suggestedModelId: suggested,
                existingModel: modelIds.has(suggested),
                firstSeen: r.first_seen,
            };
        });
    }

    // Offers whose model the provider no longer lists (after a successful sync).
    async missing(): Promise<Set<string>> {
        const [rows, providers, offers] = await Promise.all([this.repo.discovered(), this.repo.providers(), this.repo.offers()]);
        const synced = new Map(providers.filter((p) => p.last_synced_at).map((p) => [p.id, new Date(p.last_synced_at!).getTime()]));
        const seen = new Map(rows.map((r) => [`${r.provider_id}|${r.upstream_model}`, new Date(r.last_seen).getTime()]));
        const out = new Set<string>();
        for (const o of offers) {
            const at = synced.get(o.provider_id);
            if (!at) continue;
            const last = seen.get(`${o.provider_id}|${o.upstream_model}`);
            // Not in the latest list (allow a minute for the sync's own writes).
            if (last === undefined || last < at - 60_000) out.add(o.id);
        }
        return out;
    }

    async ignore(providerId: string, upstreamModel: string) {
        if (!(await this.repo.setDiscoveredStatus(providerId, upstreamModel, "ignored"))) throw new CatalogError("Not found", 404);
    }

    async ignoreAll(providerId: string) {
        return { ignored: await this.repo.ignoreAllNew(providerId) };
    }

    // Adds a discovered model: creates the marketplace model (details from
    // OpenRouter, else Hugging Face) if it doesn't exist, then the offer.
    async approve(body: any) {
        const providerId = String(body?.providerId ?? "");
        const upstream = String(body?.upstreamModel ?? "");
        const provider = await this.repo.provider(providerId);
        if (!provider) throw new CatalogError("Provider not found", 404);
        const modelId = String(body?.modelId ?? suggestModelId(upstream, provider.name)).trim();
        // Check the prices first, so a rejected approval leaves nothing half-created.
        const price = (v: unknown) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0;
        if (!price(body?.inputPerM) || !price(body?.outputPerM)) {
            throw new CatalogError("Enter the provider's input and output price per 1M tokens (0 for free)");
        }
        if (!(await this.repo.model(modelId))) {
            const fromOpenRouter = await this.catalog.openRouterModel(modelId).catch(() => null);
            let prefill: any = fromOpenRouter;
            if (!prefill && isHfId(upstream)) {
                const hf = await huggingFaceInfo(upstream).catch(() => null);
                if (hf) prefill = { name: upstream.split("/").pop(), description: hf.description, contextLength: hf.contextLength, huggingFaceId: hf.huggingFaceId, inputModalities: hf.vision ? ["text", "image"] : ["text"] };
            }
            await this.own.saveModel({ id: modelId, ...(body?.name ? { name: body.name } : {}) }, prefill);
        }
        const offer = await this.own.saveOffer(null, {
            modelId, providerId, upstreamModel: upstream,
            inputPerM: body?.inputPerM, outputPerM: body?.outputPerM,
            contextLength: body?.contextLength ?? null, markupPct: body?.markupPct ?? null,
        });
        await this.repo.setDiscoveredStatus(providerId, upstream, "added");
        return { modelId, offer };
    }
}
