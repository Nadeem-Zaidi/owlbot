import { NextFunction, Request, Response, Router } from "express";
import { SearchRepository } from "../repository/search_repository";
import { totalTokens, UsageRepository } from "../repository/usage_repository";
import { estimateCostUsd } from "../service/usage_pricing";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err) => {
        console.error("[insights] request failed:", err);
        if (!res.headersSent) res.status(500).json({ message: "Something went wrong" });
    });
};

const withCost = <T extends { model?: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }>(row: T) =>
    ({ ...row, total_tokens: totalTokens(row), cost_usd: estimateCostUsd(row.model, row) });

// /api/search (chat search) and /api/usage (token usage), behind Firebase auth.
export function createInsightsRouters(search: SearchRepository, usage: UsageRepository) {
    const searchRouter = Router();
    searchRouter.get("/", h(async (req, res) => {
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
        if (q.length < 2) return res.json({ query: q, results: [] });
        if (q.length > 200) return res.status(400).json({ message: "Search text is too long" });
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
        const offset = Math.min(1000, Math.max(0, Math.floor(Number(req.query.offset) || 0)));
        const { results, hasMore } = await search.searchChats(req.user!.sub, q, limit, offset);
        return res.json({ query: q, results, nextOffset: hasMore ? offset + results.length : null });
    }));

    const usageRouter = Router();
    usageRouter.get("/summary", h(async (req, res) => {
        const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
        const s = await usage.summary(req.user!.sub, days);
        const byModel = s.byModel.map(withCost);
        const known = byModel.filter((m) => m.cost_usd !== null);
        return res.json({
            days,
            totals: { ...s.totals, total_tokens: totalTokens(s.totals) },
            // Only models with a known price count towards the estimate.
            estimated_cost_usd: known.reduce((n, m) => n + (m.cost_usd ?? 0), 0),
            cost_is_partial: known.length < byModel.length,
            byDay: s.byDay.map((d) => ({ ...d, total_tokens: totalTokens(d) })),
            byModel,
            bySource: s.bySource.map((x) => ({ ...x, total_tokens: totalTokens(x) })),
            topChats: s.topChats.map((x) => ({ ...x, total_tokens: totalTokens(x) })),
        });
    }));
    usageRouter.get("/session/:id", h(async (req, res) => {
        const t = await usage.sessionTotals(req.user!.sub, String(req.params.id));
        return res.json({ ...t, total_tokens: totalTokens(t) });
    }));

    return { searchRouter, usageRouter };
}
