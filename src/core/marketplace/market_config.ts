// Marketplace settings (from .env) and money helpers.
//
// Credits are US dollars, like OpenRouter's, kept in nano-dollars
// (1 USD = 1e9) so per-token prices stay exact. Users pay in rupees through
// Razorpay at MARKET_USD_INR, plus the platform fee.
//
// How the owner earns (the same two levers OpenRouter uses):
//  - a fee on every credit purchase (MARKET_PURCHASE_FEE_PCT, default 5.5%);
//  - an optional markup on usage (MARKET_USAGE_MARKUP_PCT, default 0%).

export const NANOS_PER_USD = 1_000_000_000;

const num = (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
};

export type MarketConfig = {
    apiKey: string;              // the owner's OpenRouter key — every request runs on it
    baseUrl: string;
    purchaseFeePct: number;
    usageMarkupPct: number;
    usdInr: number;              // rupees per dollar of credit
    minTopupUsd: number;
    maxTopupUsd: number;
    apiRequestsPerMinute: number; // per developer API key
    maxKeysPerUser: number;
    // OpenRouter serves models you don't offer yourself (and is the last fallback).
    openrouterFallback: boolean;
};

export function marketConfig(): MarketConfig {
    return {
        apiKey: process.env.OPENROUTER_API_KEY?.trim() ?? "",
        baseUrl: (process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
        purchaseFeePct: num("MARKET_PURCHASE_FEE_PCT", 5.5, 0, 50),
        usageMarkupPct: num("MARKET_USAGE_MARKUP_PCT", 0, 0, 200),
        usdInr: num("MARKET_USD_INR", 88, 1, 1000),
        minTopupUsd: num("MARKET_MIN_TOPUP_USD", 5, 1, 10_000),
        maxTopupUsd: num("MARKET_MAX_TOPUP_USD", 1000, 1, 100_000),
        apiRequestsPerMinute: num("MARKET_API_RPM", 60, 1, 10_000),
        maxKeysPerUser: num("MARKET_MAX_KEYS", 20, 1, 1000),
        openrouterFallback: (process.env.MARKET_OPENROUTER_FALLBACK ?? "true").trim().toLowerCase() !== "false",
    };
}

export const usdToNanos = (usd: number) => Math.round(usd * NANOS_PER_USD);
export const nanosToUsd = (nanos: number) => nanos / NANOS_PER_USD;

// What a user is charged for usage that cost us `upstreamUsd`.
// `markupPct` overrides the global markup (a per-model price set by the owner).
export function chargeFor(upstreamUsd: number, cfg: MarketConfig, markupPct?: number | null): { charged: number; upstream: number } {
    const upstream = Math.max(0, usdToNanos(upstreamUsd));
    return { upstream, charged: Math.ceil(upstream * (1 + (markupPct ?? cfg.usageMarkupPct) / 100)) };
}

// Rupees (in paise) a user pays for `usd` of credit: credit value + platform fee.
export function quoteTopup(usd: number, cfg: MarketConfig): { creditsNanos: number; basePaise: number; feePaise: number; amountPaise: number } {
    const basePaise = Math.round(usd * cfg.usdInr * 100);
    const feePaise = Math.round(basePaise * cfg.purchaseFeePct / 100);
    return { creditsNanos: usdToNanos(usd), basePaise, feePaise, amountPaise: basePaise + feePaise };
}
