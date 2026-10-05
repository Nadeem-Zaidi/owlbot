import { TokenCounts } from "../repository/usage_repository";

// Estimated prices in US dollars per million tokens, used only to show an
// approximate cost on the Usage page. Check the providers' pricing pages and
// update these when prices change. Models not listed show no cost.
//   cacheWrite ≈ 1.25 × input (5-minute prompt cache)
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

const PRICES: Record<string, Price> = {
    "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
};

export function estimateCostUsd(model: string | null | undefined, c: TokenCounts): number | null {
    const p = model ? PRICES[model] : undefined;
    if (!p) return null;
    return (c.input_tokens * p.input + c.output_tokens * p.output + c.cache_read_tokens * p.cacheRead + c.cache_write_tokens * p.cacheWrite) / 1_000_000;
}
