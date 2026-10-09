import express, { NextFunction, Request, Response, Router } from "express";
import { createHash } from "node:crypto";
import { ApiKeyRow } from "../../repository/market_repository";
import { isModelId } from "./catalog";
import { MarketplaceService } from "./marketplace_service";
import { retryableStatus, Route, Router as MarketRouter } from "./router";
import { callAnthropic } from "./anthropic_adapter";

// /api/v1 — the developer API: OpenAI-compatible, like OpenRouter's.
//   GET  /api/v1/models              catalogue (public)
//   POST /api/v1/chat/completions    any model, streaming or not (sk-owl-… key)
//   GET  /api/v1/key                 the key's usage and limit
//   GET  /api/v1/credits             the account's balance
// Requests run on the owner's OpenRouter key and are charged to the key
// owner's credits at OpenRouter's reported cost (+ the usage markup).

const MAX_CONCURRENT_PER_USER = 20;
const GENERATION_RETRY_MS = [2_000, 5_000, 15_000];

type Authed = Request & { marketKey?: ApiKeyRow };

const apiError = (res: Response, status: number, message: string, code: string) =>
    res.status(status).json({ error: { message, code, type: code } });

export function createMarketApiRouter(market: MarketplaceService): Router {
    const r = Router();
    r.use(express.json({ limit: "20mb" }));
    const windows = new Map<string, number[]>();
    const inflight = new Map<string, number>();

    const auth = async (req: Authed, res: Response, next: NextFunction) => {
        const header = String(req.headers.authorization ?? "");
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        const key = token ? await market.authenticate(token).catch(() => null) : null;
        if (!key) return apiError(res, 401, "Invalid or missing API key. Create one on the API keys page and send it as \"Authorization: Bearer sk-owl-…\".", "invalid_api_key");
        if (key.disabled) return apiError(res, 403, "This API key is disabled.", "key_disabled");
        req.marketKey = key;
        next();
    };

    const rateLimited = (keyId: string): boolean => {
        const now = Date.now();
        const recent = (windows.get(keyId) ?? []).filter((t) => now - t < 60_000);
        if (recent.length >= market.cfg.apiRequestsPerMinute) {
            windows.set(keyId, recent);
            return true;
        }
        recent.push(now);
        windows.set(keyId, recent);
        if (windows.size > 10_000) windows.delete(windows.keys().next().value!);
        return false;
    };

    // ── catalogue (public, OpenRouter's format with this server's prices) ──
    r.get("/models", async (_req, res) => {
        try {
            const list = await market.models();
            res.json({
                data: list.map((m) => ({
                    id: m.id,
                    name: m.name,
                    created: m.created,
                    description: m.description,
                    context_length: m.contextLength,
                    architecture: { input_modalities: m.inputModalities, output_modalities: m.outputModalities },
                    pricing: { prompt: String(m.price.input / 1e6), completion: String(m.price.output / 1e6), request: String(m.price.request) },
                    top_provider: { context_length: m.contextLength, max_completion_tokens: m.maxOutput },
                    supported_features: { tools: m.tools, reasoning: m.reasoning, structured_outputs: m.structuredOutput },
                })),
            });
        } catch {
            apiError(res, 502, "Couldn't load the model list right now.", "upstream_error");
        }
    });

    r.get("/key", auth, (req: Authed, res) => res.json({ data: market.keyInfo(req.marketKey!) }));

    r.get("/credits", auth, async (req: Authed, res) => {
        res.json({ data: { balance: await market.balanceUsd(req.marketKey!.user_id) } });
    });

    // ── chat completions ──
    r.post("/chat/completions", auth, async (req: Authed, res) => {
        const key = req.marketKey!;
        const userId = key.user_id;
        const body = req.body && typeof req.body === "object" ? { ...req.body } : null;
        if (!body) return apiError(res, 400, "Send a JSON body.", "bad_request");
        const requested = typeof body.model === "string" ? body.model.trim() : "";
        if (!requested || !isModelId(requested)) return apiError(res, 400, "Set \"model\" to a model id from GET /api/v1/models, e.g. \"qwen/qwen3-32b\".", "bad_request");
        if (!Array.isArray(body.messages) || !body.messages.length) return apiError(res, 400, "\"messages\" must be a non-empty array.", "bad_request");
        const model = requested === "openrouter/auto" ? null : await market.catalog.get(requested).catch(() => null);
        if (requested !== "openrouter/auto" && !model) return apiError(res, 404, `Model "${requested}" isn't available.`, "model_not_found");

        if (rateLimited(key.id)) return apiError(res, 429, `Rate limit reached (${market.cfg.apiRequestsPerMinute} requests per minute per key).`, "rate_limited");
        const blocked = await market.blockedReason(userId);
        if (blocked) return apiError(res, market.enabled ? 402 : 503, blocked, market.enabled ? "insufficient_credits" : "not_configured");
        if (market.keyLimitReached(key)) return apiError(res, 402, "This API key has reached its credit limit.", "key_limit_reached");
        if ((inflight.get(userId) ?? 0) >= MAX_CONCURRENT_PER_USER) return apiError(res, 429, "Too many requests at once — wait for some to finish.", "too_many_concurrent");

        inflight.set(userId, (inflight.get(userId) ?? 0) + 1);
        const controller = new AbortController();
        res.on("close", () => { if (!res.writableEnded) controller.abort(); });
        const stream = body.stream === true;
        // Billing fields are ours; the end-user id helps OpenRouter's abuse checks.
        delete body.usage;
        body.user = createHash("sha256").update(userId).digest("hex").slice(0, 32);

        let usage: any = null;
        let generationId: string | null = null;
        let servedModel: string = requested;
        let served: Route | null = null;
        let streamedChars = 0;
        const promptChars = JSON.stringify(body.messages ?? "").length;
        const routes = await market.routes(requested, null).catch(() => [] as Route[]);
        try {
            if (!routes.length) return apiError(res, 503, `"${requested}" isn't available right now.`, "upstream_unavailable");
            for (let i = 0; i < routes.length; i++) {
                const route = routes[i];
                const last = i === routes.length - 1;
                let upstream: globalThis.Response;
                const startedAt = Date.now();
                try {
                    upstream = await callRoute(market, route, body, stream, controller.signal);
                } catch (err) {
                    if (controller.signal.aborted) return;
                    market.router?.failure(route);
                    if (!last) continue;
                    console.error("[market-api] request failed:", err instanceof Error ? err.message : err);
                    return apiError(res, 502, "Couldn't reach the model provider.", "upstream_error");
                }
                if (!upstream.ok || !upstream.body) {
                    const text = await upstream.text().catch(() => "");
                    // Provider-side problems (rate limit, outage, the owner's key or account): try the next provider.
                    if (retryableStatus(upstream.status) || upstream.status === 402) {
                        market.router?.failure(route);
                        if (!last) continue;
                    }
                    // Provider-side failures (outage, rate limit, the owner's key or credit) are
                    // reported generically — customers never see which provider or its message.
                    if (upstream.status === 429) return apiError(res, 429, "The model is busy right now — please retry in a moment.", "rate_limited");
                    if (retryableStatus(upstream.status) || upstream.status === 402) return apiError(res, 503, "The service is temporarily unavailable. Please try again later.", "upstream_unavailable");
                    // Problems with the request itself (bad parameters, too long…) are passed through.
                    let message = `The model provider returned an error (${upstream.status}).`;
                    try { message = JSON.parse(text)?.error?.message ?? message; } catch { /* not JSON */ }
                    return apiError(res, upstream.status, message, upstream.status === 429 ? "rate_limited" : "upstream_error");
                }
                served = route;
                const firstByteMs = Date.now() - startedAt;
                if (!stream) {
                    const json: any = await upstream.json();
                    usage = json?.usage ?? null;
                    generationId = json?.id ?? null;
                    if (route.kind === "openrouter" && json?.model) servedModel = json.model;
                    // Customers see the marketplace model id, not the provider's internal name.
                    if (route.kind !== "openrouter" && json && typeof json === "object") json.model = requested;
                    res.json(json);
                } else {
                    res.status(200);
                    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
                    res.setHeader("Cache-Control", "no-cache, no-transform");
                    res.setHeader("X-Accel-Buffering", "no");
                    res.flushHeaders?.();
                    const reader = upstream.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        res.write(Buffer.from(value));
                        buffer += decoder.decode(value, { stream: true });
                        let nl: number;
                        while ((nl = buffer.indexOf("\n")) >= 0) {
                            const line = buffer.slice(0, nl).trim();
                            buffer = buffer.slice(nl + 1);
                            if (!line.startsWith("data:")) continue;
                            const data = line.slice(5).trim();
                            if (!data || data === "[DONE]") continue;
                            try {
                                const evt = JSON.parse(data);
                                if (evt?.id && !generationId) generationId = evt.id;
                                if (route.kind === "openrouter" && evt?.model) servedModel = evt.model;
                                if (evt?.usage) usage = evt.usage;
                                const delta = evt?.choices?.[0]?.delta;
                                if (typeof delta?.content === "string") streamedChars += delta.content.length;
                            } catch { /* comment or partial line */ }
                        }
                    }
                    res.end();
                }
                // Latency = time until the provider started answering.
                market.router?.success(route, null, firstByteMs);
                break;
            }
        } catch (err) {
            if (!controller.signal.aborted) {
                console.error("[market-api] request failed:", err instanceof Error ? err.message : err);
                if (!res.headersSent) apiError(res, 502, "Couldn't reach the model provider.", "upstream_error");
                else res.end();
            }
        } finally {
            inflight.set(userId, Math.max(0, (inflight.get(userId) ?? 1) - 1));
            if (served) void settle(market, { userId, keyId: key.id, model, requested, servedModel, usage, generationId, route: served, promptChars, streamedChars });
        }
    });

    return r;
}

// OpenRouter-only request fields that direct providers would reject.
const OPENROUTER_ONLY = ["provider", "models", "transforms", "route", "plugins", "usage"];

// Sends the request to one route (own provider account, or OpenRouter).
function callRoute(market: MarketplaceService, route: Route, body: Record<string, any>, stream: boolean, signal: AbortSignal): Promise<globalThis.Response> {
    const upstream: Record<string, any> = { ...body, model: route.upstreamModel };
    if (route.kind === "openrouter") return market.openrouter.chat(upstream, signal);
    // Claude: the native Messages API, translated to and from the OpenAI format.
    if (route.kind === "anthropic") return callAnthropic(route, body, stream, signal, route.modelId);
    for (const k of OPENROUTER_ONLY) delete upstream[k];
    // Ask for token counts in streams — that's what the request is charged from.
    if (stream) upstream.stream_options = { ...(typeof body.stream_options === "object" ? body.stream_options : {}), include_usage: true };
    return fetch(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify(upstream),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]),
    });
}

type Settle = {
    userId: string; keyId: string; model: Awaited<ReturnType<MarketplaceService["catalog"]["get"]>>; requested: string; servedModel: string;
    usage: any; generationId: string | null; route: Route; promptChars: number; streamedChars: number;
};

// Charges a finished request. Own providers: tokens × that provider's price.
// OpenRouter: its exact reported cost (or the generation lookup if the
// stream dropped). Without usage at all, an estimate from the text sizes.
async function settle(market: MarketplaceService, s: Settle) {
    try {
        let input = Number(s.usage?.prompt_tokens ?? 0);
        let output = Number(s.usage?.completion_tokens ?? 0);
        const cached = Number(s.usage?.prompt_tokens_details?.cached_tokens ?? s.usage?.prompt_cache_hit_tokens ?? 0) || 0;
        let costUsd: number | null = s.usage ? MarketRouter.costUsd(s.route, { prompt: input, completion: output, cached }, s.usage?.cost) : null;
        if (costUsd === null && s.route.kind === "openrouter" && s.generationId) {
            for (const wait of GENERATION_RETRY_MS) {
                await new Promise((r) => setTimeout(r, wait));
                const g = await market.openrouter.generationCost(s.generationId);
                if (g) { costUsd = g.cost; input = g.input || input; output = g.output || output; break; }
            }
        }
        if (costUsd === null) {
            if (!s.usage && !s.generationId && !s.streamedChars) return;   // nothing was generated
            input = input || Math.ceil(s.promptChars / 4);
            output = output || Math.ceil(s.streamedChars / 4);
            costUsd = s.route.prices ? MarketRouter.costUsd(s.route, { prompt: input, completion: output, cached: 0 })! : market.estimateUsd(s.model, input, output);
        }
        await market.chargeUsage({
            userId: s.userId, model: s.route.kind === "openrouter" && s.requested === "openrouter/auto" ? s.servedModel : s.requested,
            upstreamUsd: costUsd, markupPct: s.route.prices?.markupPct ?? null, provider: s.route.providerName,
            source: "api", apiKeyId: s.keyId, generationId: s.generationId, inputTokens: input, outputTokens: output,
        });
    } catch (err) {
        console.error("[market-api] couldn't charge a request:", err);
    }
}
