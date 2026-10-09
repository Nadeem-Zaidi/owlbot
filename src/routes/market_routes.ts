import { NextFunction, Request, Response, Router } from "express";
import { MarketError, MarketplaceService } from "../core/marketplace/marketplace_service";
import { CatalogError } from "../core/marketplace/own_catalog";
import { huggingFaceInfo, isHfId } from "../core/marketplace/huggingface";
import { isOwner } from "../service/agents/owner";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const known = err instanceof MarketError || err instanceof CatalogError;
        const status = known ? err.status : Number(err?.status ?? err?.statusCode) || 500;
        if (status >= 500 && !known) console.error("[market] request failed:", err);
        if (!res.headersSent) res.status(status).json({ message: status >= 500 && !known ? "Something went wrong" : err?.message ?? "Request failed", code: err?.code });
    });
};

const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    if (!isOwner(req.user?.email)) return res.status(403).json({ message: "Only the app owner can see this." });
    next();
};

// /api/market — the model marketplace for signed-in users (the developer API
// with sk-owl-… keys is /api/v1, see core/marketplace/api_v1.ts).
export function createMarketRouter(market: MarketplaceService): Router {
    const r = Router();
    const uid = (req: Request) => req.user!.sub;

    r.get("/config", h(async (req, res) => res.json({ ...market.publicConfig(), isOwner: isOwner(req.user?.email) })));

    // Catalogue + the user's chat models.
    r.get("/models", h(async (req, res) => res.json({ models: await market.models(), favorites: await market.favorites(uid(req)) })));
    // ?id=author/model — one model with its providers.
    r.get("/model", h(async (req, res) => res.json(await market.model(String(req.query.id ?? "")))));

    r.put("/favorites", h(async (req, res) => res.json({ favorites: await market.addFavorite(uid(req), req.body?.model) })));
    r.delete("/favorites", h(async (req, res) => res.json({ favorites: await market.removeFavorite(uid(req), req.query.model) })));

    // Credits.
    r.get("/wallet", h(async (req, res) => res.json(await market.wallet(uid(req)))));
    r.get("/ledger", h(async (req, res) => res.json({ entries: await market.ledger(uid(req), req.query.before) })));
    r.post("/topup", h(async (req, res) => res.json(await market.startTopup(uid(req), req.body?.usd))));
    r.post("/topup/verify", h(async (req, res) => res.json(await market.verifyTopup(uid(req), req.body))));

    // Developer API keys.
    r.get("/keys", h(async (req, res) => res.json({ keys: await market.keys(uid(req)) })));
    r.post("/keys", h(async (req, res) => res.status(201).json(await market.createKey(uid(req), req.body))));
    r.put("/keys/:id", h(async (req, res) => res.json(await market.updateKey(uid(req), String(req.params.id), req.body))));
    r.delete("/keys/:id", h(async (req, res) => {
        await market.deleteKey(uid(req), String(req.params.id));
        res.status(204).send();
    }));

    // Owner: earnings and credit adjustments.
    r.get("/admin/earnings", requireOwner, h(async (req, res) => res.json(await market.earnings(req.query.days))));
    r.post("/admin/adjust", requireOwner, h(async (req, res) => res.json(await market.adjust(req.body?.userId, req.body?.usd, req.body?.note))));

    // Owner: own catalogue — provider accounts, models, offers.
    const own = () => {
        if (!market.own) throw new MarketError("The own catalogue isn't available on this server", 503);
        return market.own;
    };
    r.get("/admin/catalog", requireOwner, h(async (_req, res) => {
        const view = await own().adminView();
        await market.router?.flush();
        await market.router?.loadStats();
        const missing = market.sync ? await market.sync.missing() : new Set<string>();
        res.json({
            ...view,
            // 24h requests, uptime and latency per provider (all servers).
            providers: view.providers.map((p) => ({ ...p, health: market.router?.providerHealth(p.id) ?? null })),
            // Offers whose model the provider stopped listing.
            models: view.models.map((m) => ({ ...m, offers: m.offers.map((o) => ({ ...o, missingUpstream: missing.has(o.id) })) })),
            discoverCount: market.sync ? (await market.sync.view()).length : 0,
            openrouterFallback: market.cfg.openrouterFallback,
            openrouterConfigured: market.openrouter.configured,
        });
    }));
    r.post("/admin/providers", requireOwner, h(async (req, res) => res.status(201).json(await own().saveProvider(null, req.body))));
    r.put("/admin/providers/:id", requireOwner, h(async (req, res) => res.json(await own().saveProvider(String(req.params.id), req.body))));
    r.delete("/admin/providers/:id", requireOwner, h(async (req, res) => { await own().deleteProvider(String(req.params.id)); res.status(204).send(); }));
    r.post("/admin/providers/:id/test", requireOwner, h(async (req, res) => res.json(await own().testProvider(String(req.params.id)))));
    // Prefill a model's details from OpenRouter's public catalogue (when it lists it).
    r.get("/admin/prefill", requireOwner, h(async (req, res) => {
        const id = String(req.query.id ?? "");
        const m = await market.catalog.openRouterModel(id).catch(() => null);
        if (!m) return res.json({ model: null });
        const { upstream: _u, ...rest } = m;
        res.json({ model: rest });
    }));
    r.post("/admin/models", requireOwner, h(async (req, res) => {
        const id = String(req.body?.id ?? "");
        const prefill = req.body?.prefill ? await market.catalog.openRouterModel(id).catch(() => null) : null;
        res.status(201).json(await own().saveModel(req.body, prefill));
    }));
    r.put("/admin/models", requireOwner, h(async (req, res) => res.json(await own().saveModel(req.body))));
    r.delete("/admin/models", requireOwner, h(async (req, res) => { await own().deleteModel(String(req.query.id ?? "")); res.status(204).send(); }));
    // Provider sync: what providers list that you don't sell yet.
    const sync = () => {
        if (!market.sync) throw new MarketError("Provider sync isn't available on this server", 503);
        return market.sync;
    };
    r.get("/admin/discover", requireOwner, h(async (_req, res) => res.json({ items: await sync().view() })));
    r.post("/admin/sync", requireOwner, h(async (req, res) => {
        const id = typeof req.body?.providerId === "string" ? req.body.providerId : null;
        res.json(id ? { results: [{ ...(await sync().syncOne(id)) }] } : { results: await sync().syncAll() });
    }));
    r.post("/admin/discover/approve", requireOwner, h(async (req, res) => res.status(201).json(await sync().approve(req.body))));
    r.post("/admin/discover/ignore", requireOwner, h(async (req, res) => { await sync().ignore(String(req.body?.providerId ?? ""), String(req.body?.upstreamModel ?? "")); res.status(204).send(); }));
    r.post("/admin/discover/ignore-all", requireOwner, h(async (req, res) => res.json(await sync().ignoreAll(String(req.body?.providerId ?? "")))));
    // Details for an open model from Hugging Face (?id=Org/Model).
    r.get("/admin/hf", requireOwner, h(async (req, res) => {
        const id = String(req.query.id ?? "");
        if (!isHfId(id)) throw new MarketError("Enter a Hugging Face model id like \"Qwen/Qwen3-32B\"");
        res.json({ model: await huggingFaceInfo(id) });
    }));
    r.post("/admin/offers", requireOwner, h(async (req, res) => res.status(201).json(await own().saveOffer(null, req.body))));
    r.put("/admin/offers/:id", requireOwner, h(async (req, res) => res.json(await own().saveOffer(String(req.params.id), req.body))));
    r.delete("/admin/offers/:id", requireOwner, h(async (req, res) => { await own().deleteOffer(String(req.params.id)); res.status(204).send(); }));

    return r;
}
