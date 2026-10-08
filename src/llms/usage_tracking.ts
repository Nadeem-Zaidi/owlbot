import { ChatRunOptions, ILLM } from "../interfaces/illm";
import { emptyCounts, TokenCounts, totalTokens, UsageRepository } from "../repository/usage_repository";
import { LLMMessage, Tool } from "../types/llm_message";
import { metrics } from "../infra/observability";

function countTokens(provider: string, kind: string, byok: boolean, usage: Partial<TokenCounts>) {
    const base = { provider, kind, byok };
    metrics.llmTokens.inc({ ...base, direction: "input" }, (usage.input_tokens || 0) + (usage.cache_read_tokens || 0) + (usage.cache_write_tokens || 0));
    metrics.llmTokens.inc({ ...base, direction: "output" }, usage.output_tokens || 0);
}

// Providers report each model call's tokens as an internal chunk:
//   { type: "usage_increment", usage: TokenCounts, model, kind?: "title" }
export type UsageIncrement = { type: "usage_increment"; usage: TokenCounts; model?: string; kind?: UsageKind };
// "compaction": the context engine summarizing older messages of a long chat.
export type UsageKind = "chat" | "title" | "compaction";

// Providers report usage only when a reply completes. When the user presses
// Stop, the provider has still billed the input and the output generated so
// far, so record an estimate (~4 characters per token) instead of nothing —
// otherwise cancelled replies are free on the Usage page and the quota.
export function estimatedUsageIncrement(inputChars: number, outputChars: number, model?: string): LLMMessage {
    return usageIncrement({
        input_tokens: Math.ceil(Math.max(0, inputChars) / 4),
        output_tokens: Math.ceil(Math.max(0, outputChars) / 4),
    }, model);
}

export function usageIncrement(usage: Partial<TokenCounts>, model?: string, kind: UsageKind = "chat"): LLMMessage {
    return { type: "usage_increment", usage: { ...emptyCounts(), ...usage }, model, kind } as unknown as LLMMessage;
}

function add(into: TokenCounts, more: TokenCounts) {
    into.input_tokens += more.input_tokens || 0;
    into.output_tokens += more.output_tokens || 0;
    into.cache_read_tokens += more.cache_read_tokens || 0;
    into.cache_write_tokens += more.cache_write_tokens || 0;
}

/**
 * Wraps a provider so every chat turn's token usage is recorded — for the web
 * chat, WhatsApp, agents, schedules and pipelines alike, since they all go
 * through chatStream. Per turn it:
 *  - sums the provider's usage_increment chunks (one per model call),
 *  - saves one token_usage row (plus one per title generation),
 *  - stores the total on the turn's final reply (metadata.usage),
 *  - emits a single { type: "usage" } chunk before the turn's last chunk.
 */
export class UsageTrackingLLM implements ILLM {
    // Set once at startup (billing): returns a message when the user is over
    // their plan's monthly tokens. Applies to every feature, since they all
    // call chatStream through this wrapper.
    static quotaGate: ((userId: string) => Promise<string | null>) | null = null;

    // `byok`: this provider runs on the user's own API key — no quota check,
    // and its usage is recorded as BYOK (excluded from the plan's quota).
    constructor(private inner: ILLM, private usage: UsageRepository, private byok: { keyId: string } | null = null) {}

    chat(messages: LLMMessage[], tools: Tool[]) { return this.inner.chat(messages, tools); }
    summarizeChat(message: any, userId: string, sessionId: string) { return this.inner.summarizeChat(message, userId, sessionId); }
    getProvider() { return this.inner.getProvider(); }
    getModel() { return this.inner.getModel(); }
    getModels() { return this.inner.getModels?.() ?? [this.inner.getModel()]; }
    supportsTools() { return this.inner.supportsTools(); }

    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string, apiKey: string, signal: AbortSignal, model?: string, run?: ChatRunOptions): AsyncGenerator<LLMMessage, void, unknown> {
        const turn = emptyCounts();
        let requests = 0;
        let servedBy = model ?? this.inner.getModel();
        let emitted = false;
        const blocked = !this.byok && UsageTrackingLLM.quotaGate ? await UsageTrackingLLM.quotaGate(userId).catch(() => null) : null;
        if (blocked) {
            yield { type: "error", code: "quota_exceeded", message: blocked } as unknown as LLMMessage;
            return;
        }
        const startId = await this.usage.lastMessageId(sessionId).catch(() => 0);

        const summary = () => ({ ...turn, total_tokens: totalTokens(turn), requests, model: servedBy, provider: this.inner.getProvider(), byok: !!this.byok });
        const own = { byok: !!this.byok, keyId: this.byok?.keyId ?? null };

        try {
            for await (const chunk of this.inner.chatStream(messages, userId, sessionId, apiKey, signal, model, run)) {
                if ((chunk as any).type === "usage_increment") {
                    const inc = chunk as unknown as UsageIncrement;
                    if (inc.kind === "title" || inc.kind === "compaction") {
                        // Side calls get their own row (still on the user's account / own key).
                        const kind = inc.kind;
                        countTokens(this.inner.getProvider(), kind, !!this.byok, inc.usage);
                        void this.usage.record({ userId, sessionId, kind, provider: this.inner.getProvider(), model: inc.model, ...own, ...inc.usage })
                            .catch((e) => console.error(`[usage] couldn't record ${kind} usage:`, e));
                    } else {
                        add(turn, inc.usage);
                        requests++;
                        if (inc.model) servedBy = inc.model;
                    }
                    continue;
                }
                // Send the total just before the turn ends, while the client is still listening.
                const ending = chunk.isDone || chunk.type === "error" || chunk.type === "cancelled";
                if (ending && requests > 0 && !emitted) {
                    emitted = true;
                    yield { type: "usage", usage: summary() } as unknown as LLMMessage;
                }
                yield chunk;
            }
            if (requests > 0 && !emitted) yield { type: "usage", usage: summary() } as unknown as LLMMessage;
        } finally {
            if (requests > 0) {
                try {
                    countTokens(this.inner.getProvider(), "chat", !!this.byok, turn);
                    await this.usage.record({ userId, sessionId, kind: "chat", provider: this.inner.getProvider(), model: servedBy, requests, ...own, ...turn });
                    await this.usage.attachToLastReply(sessionId, startId, summary());
                } catch (e) {
                    console.error("[usage] couldn't record usage:", e);
                }
            }
        }
    }
}
