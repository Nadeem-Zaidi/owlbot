import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import { ApiKeyRow, DuplicatePaymentError, LedgerRow, MarketRepository } from "../../repository/market_repository";
import { Catalog, CatalogModel, isModelId } from "./catalog";
import { chargeFor, MarketConfig, marketConfig, nanosToUsd, quoteTopup, usdToNanos } from "./market_config";
import { OpenRouterClient } from "./openrouter";
import { MarketCatalogRepository } from "../../repository/market_catalog_repository";
import { OwnCatalog } from "./own_catalog";
import { Route, Router } from "./router";
import { ProviderSync } from "./provider_sync";

export class MarketError extends Error {
    constructor(message: string, public status = 400, public code = "bad_request") {
        super(message);
    }
}

// The parts of the Razorpay SDK used here (tests pass a fake).
export type RazorpayOrdersClient = {
    orders: { create(body: any): Promise<any> };
    payments: { fetch(id: string): Promise<any>; capture(id: string, amount: number, currency: string): Promise<any> };
};

const KEY_PREFIX = "sk-owl-v1-";
const MAX_FAVORITES = 50;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (secret: string, message: string) => createHmac("sha256", secret).update(message).digest("hex");
const safeEqual = (a: string, b: string) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
};
const usd = (nanos: number | string) => Math.round(nanosToUsd(Number(nanos)) * 1e6) / 1e6;
const rupees = (paise: number | string) => Math.round(Number(paise)) / 100;

export type UsageCharge = {
    userId: string;
    model: string;
    upstreamUsd: number;
    source: "chat" | "api";
    provider?: string | null;
    markupPct?: number | null;
    sessionId?: string | null;
    apiKeyId?: string | null;
    generationId?: string | null;
    inputTokens?: number;
    outputTokens?: number;
};

// The model marketplace: the owner's catalogue (own provider accounts, with
// OpenRouter as an optional fallback), prepaid credits bought with Razorpay,
// usage charged per request, developer API keys and the owner's earnings.
export class MarketplaceService {
    readonly openrouter: OpenRouterClient;
    readonly catalog: Catalog;
    readonly own: OwnCatalog | null;
    readonly router: Router | null;
    readonly sync: ProviderSync | null;
    private catalogRepo: MarketCatalogRepository | null;
    private razorpay: RazorpayOrdersClient | null;
    private rzpKeyId: string;
    private rzpSecret: string;

    constructor(
        private repo: MarketRepository,
        private cfgFn: () => MarketConfig = marketConfig,
        opts: { razorpay?: RazorpayOrdersClient | null; openrouter?: OpenRouterClient; razorpayKeyId?: string; razorpayKeySecret?: string; catalogRepo?: MarketCatalogRepository } = {},
    ) {
        const cfg = cfgFn();
        this.openrouter = opts.openrouter ?? new OpenRouterClient(cfg);
        this.catalog = new Catalog(this.openrouter, cfgFn);
        this.own = opts.catalogRepo ? new OwnCatalog(opts.catalogRepo, cfgFn) : null;
        this.router = this.own ? new Router(this.own, this.openrouter, cfgFn, (id) => this.catalog.openRouterHas(id), opts.catalogRepo ?? null) : null;
        if (this.own) this.catalog.setOwn(this.own);
        this.catalogRepo = opts.catalogRepo ?? null;
        this.sync = this.own && opts.catalogRepo ? new ProviderSync(opts.catalogRepo, this.own, this.catalog) : null;
        this.rzpKeyId = opts.razorpayKeyId ?? process.env.RAZORPAY_KEY_ID ?? "";
        this.rzpSecret = opts.razorpayKeySecret ?? process.env.RAZORPAY_KEY_SECRET ?? "";
        this.razorpay = opts.razorpay !== undefined ? opts.razorpay
            : this.rzpKeyId && this.rzpSecret ? (new Razorpay({ key_id: this.rzpKeyId, key_secret: this.rzpSecret }) as unknown as RazorpayOrdersClient) : null;
    }

    get cfg(): MarketConfig { return this.cfgFn(); }
    // Using models needs a provider account (own, or OpenRouter); browsing works without.
    get enabled(): boolean { return this.openrouter.configured || !!this.own?.ready; }

    // Loads the own catalogue once at startup (so `enabled` is right from the first request).
    async init(): Promise<void> {
        await this.own?.models().catch((err) => console.warn("[marketplace] couldn't load the own catalogue:", err instanceof Error ? err.message : err));
        await this.router?.loadStats().catch(() => {});
    }

    // On shutdown: save the last health counts.
    async close(): Promise<void> {
        this.router?.stop();
        this.sync?.stop();
        await this.router?.flush();
    }

    // Who should serve a model, in order (own offers, then OpenRouter if allowed).
    async routes(modelId: string, sessionId?: string | null): Promise<Route[]> {
        if (this.router) return this.router.routes(modelId, sessionId);
        if (!this.openrouter.configured) return [];
        const c = this.cfg;
        return [{ modelId, kind: "openrouter", providerId: "openrouter", providerName: "OpenRouter", baseUrl: c.baseUrl, apiKey: c.apiKey, upstreamModel: modelId, prices: null, maxOutput: null }];
    }

    publicConfig() {
        const c = this.cfg;
        return {
            enabled: this.enabled,
            paymentsEnabled: !!this.razorpay,
            purchaseFeePct: c.purchaseFeePct,
            usageMarkupPct: c.usageMarkupPct,
            usdInr: c.usdInr,
            minTopupUsd: c.minTopupUsd,
            maxTopupUsd: c.maxTopupUsd,
            apiRequestsPerMinute: c.apiRequestsPerMinute,
        };
    }

    // ── catalogue ──
    async models() {
        return (await this.catalog.list()).map(({ upstream: _u, ...m }) => m);
    }

    async model(id: string) {
        const m = await this.catalog.get(id);
        if (!m) throw new MarketError("Model not found", 404, "model_not_found");
        const endpoints = await this.catalog.endpoints(id).catch(() => []);
        const { upstream: _u, ...rest } = m;
        return { model: rest, endpoints };
    }

    // ── favourites (the chat model picker) ──
    favorites(userId: string) { return this.repo.favorites(userId); }

    async addFavorite(userId: string, modelId: unknown) {
        const id = String(modelId ?? "");
        if (!(await this.catalog.get(id))) throw new MarketError("Model not found", 404, "model_not_found");
        if ((await this.repo.countFavorites(userId)) >= MAX_FAVORITES) throw new MarketError(`You can add up to ${MAX_FAVORITES} models to chat`);
        await this.repo.addFavorite(userId, id);
        return this.repo.favorites(userId);
    }

    async removeFavorite(userId: string, modelId: unknown) {
        await this.repo.removeFavorite(userId, String(modelId ?? ""));
        return this.repo.favorites(userId);
    }

    // ── wallet ──
    async wallet(userId: string) {
        const [balance, ledger, byModel] = await Promise.all([this.repo.balance(userId), this.repo.ledger(userId, 30), this.repo.usageByModel(userId, 30)]);
        return {
            balanceUsd: usd(balance),
            ledger: ledger.map(ledgerDto),
            usage30d: byModel.map((m) => ({ ...m, spentUsd: usd(m.spentNanos), spentNanos: undefined })),
        };
    }

    async ledger(userId: string, before?: unknown) {
        const b = typeof before === "string" && /^\d+$/.test(before) ? before : null;
        return (await this.repo.ledger(userId, 50, b)).map(ledgerDto);
    }

    async balanceUsd(userId: string) { return usd(await this.repo.balance(userId)); }

    // Why a user can't start a paid request right now (null = fine).
    async blockedReason(userId: string): Promise<string | null> {
        if (!this.enabled) return "The model marketplace isn't set up on this server yet (no model provider connected).";
        if ((await this.repo.balance(userId)) <= 0) return "You're out of credits — add credits on the Credits page to keep using marketplace models.";
        return null;
    }

    // Charges one model call. Usage is charged even if it takes the balance
    // below zero (the call already happened); new calls are refused then.
    async chargeUsage(c: UsageCharge): Promise<{ chargedUsd: number; balanceUsd: number }> {
        const { charged, upstream } = chargeFor(c.upstreamUsd, this.cfg, c.markupPct);
        const balance = await this.repo.apply(c.userId, {
            kind: "usage", amountNanos: -charged, upstreamNanos: upstream, model: c.model, source: c.source, provider: c.provider ?? null,
            sessionId: c.sessionId ?? null, apiKeyId: c.apiKeyId ?? null, generationId: c.generationId ?? null,
            inputTokens: c.inputTokens ?? 0, outputTokens: c.outputTokens ?? 0,
        });
        if (c.apiKeyId && charged > 0) await this.repo.addKeyUsage(c.apiKeyId, charged).catch(() => {});
        return { chargedUsd: usd(charged), balanceUsd: usd(balance) };
    }

    estimateUsd(model: CatalogModel | null, input: number, output: number, cacheRead = 0) {
        return this.catalog.estimateUsd(model, input, output, cacheRead);
    }

    // ── buying credits (Razorpay one-time orders) ──
    async startTopup(userId: string, usdRaw: unknown) {
        const rzp = this.requireRazorpay();
        if (!this.enabled) throw new MarketError("The model marketplace isn't set up on this server yet.", 503, "not_configured");
        const c = this.cfg;
        const amount = Math.round(Number(usdRaw) * 100) / 100;
        if (!Number.isFinite(amount) || amount < c.minTopupUsd || amount > c.maxTopupUsd) {
            throw new MarketError(`Choose an amount between $${c.minTopupUsd} and $${c.maxTopupUsd}`);
        }
        const q = quoteTopup(amount, c);
        const order = await rzp.orders.create({
            amount: q.amountPaise,
            currency: "INR",
            receipt: `cr_${randomUUID().slice(0, 30)}`,
            notes: { user_id: userId, purpose: "credits", credits_usd: String(amount) },
        });
        await this.repo.createOrder({ id: order.id, userId, creditsNanos: q.creditsNanos, amountPaise: q.amountPaise, feePaise: q.feePaise, usdInr: c.usdInr });
        return { orderId: order.id as string, keyId: this.rzpKeyId, amountPaise: q.amountPaise, feePaise: q.feePaise, creditsUsd: amount, usdInr: c.usdInr };
    }

    // Checkout's success callback (the webhook confirms it again later; crediting happens once).
    async verifyTopup(userId: string, body: any) {
        const orderId = String(body?.razorpay_order_id ?? "");
        const paymentId = String(body?.razorpay_payment_id ?? "");
        const signature = String(body?.razorpay_signature ?? "");
        if (!orderId || !paymentId || !signature) throw new MarketError("Missing payment details");
        const order = await this.repo.getOrder(orderId);
        if (!order || order.user_id !== userId) throw new MarketError("Order not found", 404);
        if (!this.rzpSecret || !safeEqual(hmac(this.rzpSecret, `${orderId}|${paymentId}`), signature)) {
            throw new MarketError("Payment verification failed", 400);
        }
        const payment = await this.requireRazorpay().payments.fetch(paymentId);
        await this.creditPayment(payment);
        return this.wallet(userId);
    }

    // From the Razorpay webhook (any payment event): credits it if it's for a credits order.
    async onRazorpayPayment(payment: any): Promise<boolean> {
        if (!payment?.order_id) return false;
        const order = await this.repo.getOrder(String(payment.order_id));
        if (!order) return false;
        await this.creditPayment(payment);
        return true;
    }

    private async creditPayment(payment: any): Promise<void> {
        const order = payment?.order_id ? await this.repo.getOrder(String(payment.order_id)) : null;
        if (!order) throw new MarketError("Order not found", 404);
        if (order.status === "paid") return;
        let status = String(payment.status ?? "");
        if (Number(payment.amount) !== Number(order.amount_paise) || String(payment.currency ?? "INR") !== "INR") {
            throw new MarketError("Payment amount doesn't match the order", 400);
        }
        // Accounts without auto-capture: capture the authorised payment now.
        if (status === "authorized") {
            const captured = await this.requireRazorpay().payments.capture(String(payment.id), Number(order.amount_paise), "INR").catch(() => null);
            status = String(captured?.status ?? status);
        }
        if (status !== "captured") {
            if (status === "failed") await this.repo.markOrderStatus(order.id, "failed");
            throw new MarketError("The payment hasn't completed yet — your credits will appear as soon as it does.", 409, "payment_pending");
        }
        try {
            await this.repo.apply(order.user_id, {
                kind: "purchase", amountNanos: Number(order.credits_nanos), feePaise: Number(order.fee_paise), paidPaise: Number(order.amount_paise),
                source: "razorpay", paymentId: String(payment.id), note: `Order ${order.id}`,
            });
        } catch (err) {
            if (!(err instanceof DuplicatePaymentError)) throw err;
        }
        await this.repo.markOrderPaid(order.id, String(payment.id));
    }

    private requireRazorpay(): RazorpayOrdersClient {
        if (!this.razorpay) throw new MarketError("Payments aren't set up on this server (Razorpay keys).", 503, "payments_disabled");
        return this.razorpay;
    }

    // ── developer API keys ──
    async keys(userId: string) { return (await this.repo.keys(userId)).map(keyDto); }

    async createKey(userId: string, body: any) {
        const name = String(body?.name ?? "").trim().slice(0, 60) || "API key";
        const limitNanos = parseLimit(body?.limitUsd);
        if ((await this.repo.countKeys(userId)) >= this.cfg.maxKeysPerUser) throw new MarketError(`You can have up to ${this.cfg.maxKeysPerUser} API keys`);
        const secret = KEY_PREFIX + randomBytes(24).toString("hex");
        const row = await this.repo.createKey({ id: randomUUID(), userId, name, hash: sha256(secret), prefix: secret.slice(0, KEY_PREFIX.length + 4), last4: secret.slice(-4), limitNanos });
        // The only time the full key is ever returned.
        return { ...keyDto(row), key: secret };
    }

    async updateKey(userId: string, id: string, body: any) {
        const patch: { name?: string; disabled?: boolean; limitNanos?: number | null } = {};
        if (typeof body?.name === "string") patch.name = body.name.trim().slice(0, 60) || "API key";
        if (typeof body?.disabled === "boolean") patch.disabled = body.disabled;
        if (body && "limitUsd" in body) patch.limitNanos = parseLimit(body.limitUsd);
        const row = await this.repo.updateKey(userId, id, patch);
        if (!row) throw new MarketError("Key not found", 404);
        return keyDto(row);
    }

    async deleteKey(userId: string, id: string) {
        if (!(await this.repo.deleteKey(userId, id))) throw new MarketError("Key not found", 404);
    }

    // Looks up a developer key from an Authorization header value.
    async authenticate(token: string): Promise<ApiKeyRow | null> {
        if (!token.startsWith(KEY_PREFIX) || token.length > 100) return null;
        return this.repo.keyByHash(sha256(token));
    }

    keyLimitReached(key: ApiKeyRow): boolean {
        return key.limit_nanos !== null && Number(key.usage_nanos) >= Number(key.limit_nanos);
    }

    keyInfo(key: ApiKeyRow) {
        const limit = key.limit_nanos === null ? null : usd(key.limit_nanos);
        const used = usd(key.usage_nanos);
        return { label: key.name, usage: used, limit, limit_remaining: limit === null ? null : Math.max(0, Math.round((limit - used) * 1e6) / 1e6), is_free_tier: false, rate_limit: { requests: this.cfg.apiRequestsPerMinute, interval: "1m" } };
    }

    // ── owner ──
    async earnings(daysRaw: unknown) {
        const days = Math.min(Math.max(Math.round(Number(daysRaw) || 30), 1), 365);
        const r = await this.repo.earnings(days);
        const rate = this.cfg.usdInr;
        const t = r.totals ?? {};
        const markupNanos = Number(t.usage_charged_nanos) - Number(t.upstream_nanos);
        const feesInr = rupees(t.fee_paise);
        const markupUsd = usd(markupNanos);
        const upstream = await this.openrouter.credits().catch(() => null);
        const liabilityUsd = usd(r.liability?.nanos ?? 0);
        return {
            days,
            usdInr: rate,
            purchaseFeePct: this.cfg.purchaseFeePct,
            usageMarkupPct: this.cfg.usageMarkupPct,
            totals: {
                revenueInr: rupees(t.paid_paise),
                purchases: Number(t.purchases ?? 0),
                creditsSoldUsd: usd(t.credits_sold_nanos ?? 0),
                feesInr,
                usageChargedUsd: usd(t.usage_charged_nanos ?? 0),
                upstreamCostUsd: usd(t.upstream_nanos ?? 0),
                markupUsd,
                earningsInr: Math.round((feesInr + markupUsd * rate) * 100) / 100,
                requests: Number(t.requests ?? 0),
                activeUsers: Number(t.active_users ?? 0),
            },
            allTime: {
                revenueInr: rupees(r.allTime?.paid_paise ?? 0),
                feesInr: rupees(r.allTime?.fee_paise ?? 0),
                markupUsd: usd(r.allTime?.markup_nanos ?? 0),
            },
            // Credits users still hold: OpenRouter balance must cover this.
            liability: { usd: liabilityUsd, wallets: Number(r.liability?.wallets ?? 0) },
            openrouter: upstream ? { totalUsd: upstream.total, usedUsd: upstream.used, remainingUsd: Math.round((upstream.total - upstream.used) * 100) / 100, coversLiability: upstream.total - upstream.used >= liabilityUsd } : null,
            daily: r.daily.map((d: any) => ({
                day: d.day,
                feesInr: rupees(d.fee_paise),
                revenueInr: rupees(d.paid_paise),
                markupUsd: usd(Number(d.usage_charged_nanos) - Number(d.upstream_nanos)),
                usageChargedUsd: usd(d.usage_charged_nanos),
                upstreamUsd: usd(d.upstream_nanos),
            })),
            topModels: r.models.map((m: any) => ({ model: m.model, requests: Number(m.requests), chargedUsd: usd(m.charged_nanos), upstreamUsd: usd(m.upstream_nanos) })),
            topUsers: r.users.map((u: any) => ({ userId: u.user_id, paidInr: rupees(u.paid_paise), usageUsd: usd(u.usage_charged_nanos), requests: Number(u.requests) })),
            // Cost and margin per provider; budget = the owner's monthly spend alert (last 30 days).
            byProvider: await this.providerEarnings(r.providers, r.spend30),
        };
    }

    private async providerEarnings(rows: any[], spend30: any[]) {
        const providers = this.catalogRepo ? await this.catalogRepo.providers().catch(() => []) : [];
        const budgetOf = new Map(providers.map((p) => [p.name, p.budget_usd === null ? null : Number(p.budget_usd)]));
        const spentOf = new Map(spend30.map((s: any) => [s.provider, usd(s.upstream_nanos)]));
        const names = new Set<string>([...rows.map((r: any) => r.provider), ...providers.filter((p) => p.budget_usd !== null).map((p) => p.name)]);
        return [...names].map((name) => {
            const r = rows.find((x: any) => x.provider === name);
            const chargedUsd = r ? usd(r.charged_nanos) : 0, costUsd = r ? usd(r.upstream_nanos) : 0;
            const budgetUsd = budgetOf.get(name) ?? null, spent30Usd = spentOf.get(name) ?? 0;
            return {
                provider: name,
                requests: r ? Number(r.requests) : 0,
                chargedUsd, costUsd, marginUsd: Math.round((chargedUsd - costUsd) * 1e6) / 1e6,
                budgetUsd, spent30Usd,
                budgetUsedPct: budgetUsd ? Math.round((spent30Usd / budgetUsd) * 1000) / 10 : null,
            };
        }).sort((a, b) => b.chargedUsd - a.chargedUsd);
    }

    // Owner support action: add or remove credit (refunds, goodwill, corrections).
    async adjust(userIdRaw: unknown, usdRaw: unknown, noteRaw: unknown) {
        const userId = String(userIdRaw ?? "").trim();
        const amount = Number(usdRaw);
        if (!userId) throw new MarketError("Enter the user's id");
        if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 10_000) throw new MarketError("Enter an amount between -$10,000 and $10,000 (not 0)");
        const note = String(noteRaw ?? "").trim().slice(0, 200) || null;
        const balance = await this.repo.apply(userId, { kind: amount > 0 ? "adjustment" : "refund", amountNanos: usdToNanos(amount), source: "owner", note });
        return { userId, balanceUsd: usd(balance) };
    }
}

function parseLimit(v: unknown): number | null {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 100_000) throw new MarketError("Credit limit must be a positive amount in USD (or empty for no limit)");
    return usdToNanos(n);
}

function ledgerDto(r: LedgerRow) {
    return {
        id: r.id,
        kind: r.kind,
        amountUsd: usd(r.amount_nanos),
        balanceAfterUsd: usd(r.balance_after_nanos),
        paidInr: r.kind === "purchase" ? rupees(r.paid_paise) : undefined,
        feeInr: r.kind === "purchase" ? rupees(r.fee_paise) : undefined,
        model: r.model,
        source: r.source,
        apiKeyId: r.api_key_id,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        note: r.note,
        createdAt: r.created_at,
    };
}

function keyDto(k: ApiKeyRow) {
    return {
        id: k.id,
        name: k.name,
        hint: `${k.key_prefix}…${k.key_last4}`,
        limitUsd: k.limit_nanos === null ? null : usd(k.limit_nanos),
        usageUsd: usd(k.usage_nanos),
        disabled: k.disabled,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at,
    };
}

export { isModelId };
