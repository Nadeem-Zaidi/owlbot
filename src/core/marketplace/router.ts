import { MarketCatalogRepository, ProviderKind } from "../../repository/market_catalog_repository";
import { MarketConfig } from "./market_config";
import { OpenRouterClient } from "./openrouter";
import { OfferPrices, OwnCatalog } from "./own_catalog";

// Picks who serves a request: the model's offers on the owner's own
// provider accounts (priority, then price), with unhealthy providers moved
// to the back, the chat's last provider kept first (prompt caching), and
// OpenRouter as an optional last resort.

export type Route = {
    modelId: string;                // the marketplace model id
    kind: ProviderKind;
    providerId: string;             // "openrouter" for the OpenRouter fallback
    providerName: string;
    baseUrl: string;
    apiKey: string;
    upstreamModel: string;
    prices: OfferPrices | null;     // null: OpenRouter reports the cost itself
    maxOutput: number | null;
};

const FAILS_TO_TRIP = 3;
const TRIP_MS = 60_000;
const STICKY_MS = 60 * 60 * 1000;
// Provider-side problems worth trying another provider for.
export const RETRYABLE_CODES = new Set(["auth", "permission", "rate_limit", "server", "timeout", "network", "upstream_unavailable"]);
export const retryableStatus = (status: number) => status === 401 || status === 403 || status === 404 || status === 408 || status === 409 || status === 429 || status >= 500;

type Health = { fails: number; openUntil: number };
type Bucket = { providerId: string; modelId: string; hour: Date; requests: number; errors: number; latencySum: number; latencyCount: number };
type Stat = { requests: number; errors: number; latencySum: number; latencyCount: number };
const FLUSH_MS = 30_000;
const STATS_TTL_MS = 60_000;
const hourOf = (t = Date.now()) => new Date(Math.floor(t / 3_600_000) * 3_600_000);

export class Router {
    private health = new Map<string, Health>();
    private sticky = new Map<string, { providerId: string; at: number }>();
    // Health stats: attempts are counted in hourly buckets, flushed to the
    // database (shared by every server); the last 24h are read back for uptime.
    private pending = new Map<string, Bucket>();
    private stats: { at: number; byProvider: Map<string, Stat>; byOffer: Map<string, Stat> } | null = null;
    private statsLoading: Promise<void> | null = null;
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private own: OwnCatalog,
        private openrouter: OpenRouterClient,
        private cfg: () => MarketConfig,
        private openrouterHas: (modelId: string) => Promise<boolean>,
        private repo: MarketCatalogRepository | null = null,
    ) {
        own.statusOf = (id, modelId) => this.status(id, modelId);
        if (repo) {
            this.timer = setInterval(() => void this.flush(), FLUSH_MS);
            this.timer.unref?.();
        }
    }

    // Writes the counted attempts to the database (also called on shutdown and by tests).
    async flush(): Promise<void> {
        if (!this.repo || !this.pending.size) return;
        const rows = [...this.pending.values()];
        this.pending.clear();
        try {
            await this.repo.addStats(rows);
            this.stats = null;
        } catch (err) {
            console.warn("[marketplace] couldn't save provider stats:", err instanceof Error ? err.message : err);
        }
    }

    stop() { if (this.timer) clearInterval(this.timer); }

    private count(route: Route, ok: boolean, latencyMs?: number) {
        if (!this.repo) return;
        const hour = hourOf();
        const key = `${route.providerId}|${route.modelId}|${hour.getTime()}`;
        const b = this.pending.get(key) ?? { providerId: route.providerId, modelId: route.modelId, hour, requests: 0, errors: 0, latencySum: 0, latencyCount: 0 };
        b.requests++;
        if (!ok) b.errors++;
        if (ok && typeof latencyMs === "number" && latencyMs >= 0) { b.latencySum += latencyMs; b.latencyCount++; }
        this.pending.set(key, b);
    }

    // The last 24h per provider and per provider×model (refreshed in the background).
    private currentStats() {
        if (this.repo && (!this.stats || Date.now() - this.stats.at > STATS_TTL_MS) && !this.statsLoading) {
            this.statsLoading = this.repo.stats24h().then((rows) => {
                const byProvider = new Map<string, Stat>(), byOffer = new Map<string, Stat>();
                for (const r of rows) {
                    const s: Stat = { requests: Number(r.requests), errors: Number(r.errors), latencySum: Number(r.latency_ms_sum), latencyCount: Number(r.latency_count) };
                    byOffer.set(`${r.provider_id}|${r.model_id}`, s);
                    const p = byProvider.get(r.provider_id) ?? { requests: 0, errors: 0, latencySum: 0, latencyCount: 0 };
                    p.requests += s.requests; p.errors += s.errors; p.latencySum += s.latencySum; p.latencyCount += s.latencyCount;
                    byProvider.set(r.provider_id, p);
                }
                this.stats = { at: Date.now(), byProvider, byOffer };
            }).catch(() => {}).finally(() => { this.statsLoading = null; });
        }
        return this.stats;
    }

    // Loads the stats now (the first page view after a restart, and tests).
    async loadStats(): Promise<void> {
        this.stats = null;
        this.currentStats();
        await this.statsLoading;
    }

    private merged(providerId: string, modelId?: string): Stat {
        const base = modelId ? this.currentStats()?.byOffer.get(`${providerId}|${modelId}`) : this.currentStats()?.byProvider.get(providerId);
        const s: Stat = { requests: base?.requests ?? 0, errors: base?.errors ?? 0, latencySum: base?.latencySum ?? 0, latencyCount: base?.latencyCount ?? 0 };
        for (const b of this.pending.values()) {
            if (b.providerId !== providerId || (modelId && b.modelId !== modelId)) continue;
            s.requests += b.requests; s.errors += b.errors; s.latencySum += b.latencySum; s.latencyCount += b.latencyCount;
        }
        return s;
    }

    // Health for the owner's Providers page.
    providerHealth(providerId: string) {
        const s = this.merged(providerId);
        return {
            requests24h: s.requests,
            uptime24h: s.requests ? Math.round(((s.requests - s.errors) / s.requests) * 1000) / 10 : null,
            avgLatencyMs: s.latencyCount ? Math.round(s.latencySum / s.latencyCount) : null,
            ...this.status(providerId),
        };
    }

    async routes(modelId: string, sessionId?: string | null): Promise<Route[]> {
        const offers = await this.own.offersFor(modelId);
        let routes: Route[] = offers.map(({ offer, provider, prices }) => ({
            modelId,
            kind: provider.kind,
            providerId: provider.id,
            providerName: provider.name,
            baseUrl: provider.base_url.replace(/\/+$/, ""),
            apiKey: this.own.apiKey(provider),
            upstreamModel: offer.upstream_model,
            prices,
            maxOutput: offer.max_output,
        }));
        const now = Date.now();
        // Healthy first (stable order), tripped providers last.
        routes = [...routes.filter((r) => !this.tripped(r.providerId, now)), ...routes.filter((r) => this.tripped(r.providerId, now))];
        const stick = sessionId ? this.sticky.get(sessionId) : undefined;
        if (stick && now - stick.at < STICKY_MS) {
            const i = routes.findIndex((r) => r.providerId === stick.providerId);
            if (i > 0 && !this.tripped(stick.providerId, now)) routes.unshift(...routes.splice(i, 1));
        }
        if (this.cfg().openrouterFallback && this.openrouter.configured && (await this.openrouterHas(modelId).catch(() => false))) {
            routes.push({ modelId, kind: "openrouter", providerId: "openrouter", providerName: "OpenRouter", baseUrl: this.cfg().baseUrl, apiKey: this.cfg().apiKey, upstreamModel: modelId, prices: null, maxOutput: null });
        }
        return routes;
    }

    private tripped(providerId: string, now = Date.now()) {
        return (this.health.get(providerId)?.openUntil ?? 0) > now;
    }

    private entry(providerId: string): Health {
        let h = this.health.get(providerId);
        if (!h) {
            h = { fails: 0, openUntil: 0 };
            this.health.set(providerId, h);
        }
        return h;
    }

    success(route: Route, sessionId?: string | null, latencyMs?: number) {
        const h = this.entry(route.providerId);
        h.fails = 0;
        h.openUntil = 0;
        this.count(route, true, latencyMs);
        if (sessionId) {
            this.sticky.set(sessionId, { providerId: route.providerId, at: Date.now() });
            if (this.sticky.size > 50_000) this.sticky.delete(this.sticky.keys().next().value!);
        }
    }

    failure(route: Route) {
        const h = this.entry(route.providerId);
        h.fails++;
        this.count(route, false);
        if (h.fails >= FAILS_TO_TRIP) h.openUntil = Date.now() + TRIP_MS;
        console.warn(`[marketplace] ${route.providerName} failed for ${route.upstreamModel} (${h.fails} in a row${h.openUntil > Date.now() ? ", skipped for 60s" : ""})`);
    }

    // Live status (this server) + 24h uptime and latency (all servers).
    status(providerId: string, modelId?: string): { status: "up" | "degraded" | "down"; uptime: number | null; latencyMs: number | null } {
        const s = this.merged(providerId, modelId);
        const h = this.health.get(providerId);
        const uptime = s.requests ? Math.round(((s.requests - s.errors) / s.requests) * 1000) / 10 : null;
        const latencyMs = s.latencyCount ? Math.round(s.latencySum / s.latencyCount) : null;
        const status = this.tripped(providerId) ? "down" : (h?.fails ?? 0) > 0 || (uptime !== null && uptime < 90) ? "degraded" : "up";
        return { status, uptime, latencyMs };
    }

    // Upstream USD cost of a call on a route, from its token counts.
    static costUsd(route: Route, usage: { prompt: number; completion: number; cached: number }, reported?: number | null): number | null {
        if (!route.prices) return typeof reported === "number" ? reported : null;
        const p = route.prices;
        const uncached = Math.max(0, usage.prompt - usage.cached);
        return (uncached * p.inputPerM + usage.cached * (p.cacheReadPerM ?? p.inputPerM) + usage.completion * p.outputPerM) / 1e6 + p.request;
    }
}
