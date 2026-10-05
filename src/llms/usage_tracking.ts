import { ChatRunOptions, ILLM } from "../interfaces/illm";
import { emptyCounts, TokenCounts, totalTokens, UsageRepository } from "../repository/usage_repository";
import { LLMMessage, Tool } from "../types/llm_message";

// Providers report each model call's tokens as an internal chunk:
//   { type: "usage_increment", usage: TokenCounts, model, kind?: "title" }
export type UsageIncrement = { type: "usage_increment"; usage: TokenCounts; model?: string; kind?: "chat" | "title" };

export function usageIncrement(usage: Partial<TokenCounts>, model?: string, kind: "chat" | "title" = "chat"): LLMMessage {
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

    constructor(private inner: ILLM, private usage: UsageRepository) {}

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
        const blocked = UsageTrackingLLM.quotaGate ? await UsageTrackingLLM.quotaGate(userId).catch(() => null) : null;
        if (blocked) {
            yield { type: "error", code: "quota_exceeded", message: blocked } as unknown as LLMMessage;
            return;
        }
        const startId = await this.usage.lastMessageId(sessionId).catch(() => 0);

        const summary = () => ({ ...turn, total_tokens: totalTokens(turn), requests, model: servedBy, provider: this.inner.getProvider() });

        try {
            for await (const chunk of this.inner.chatStream(messages, userId, sessionId, apiKey, signal, model, run)) {
                if ((chunk as any).type === "usage_increment") {
                    const inc = chunk as unknown as UsageIncrement;
                    if (inc.kind === "title") {
                        void this.usage.record({ userId, sessionId, kind: "title", provider: this.inner.getProvider(), model: inc.model, ...inc.usage })
                            .catch((e) => console.error("[usage] couldn't record title usage:", e));
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
                    await this.usage.record({ userId, sessionId, kind: "chat", provider: this.inner.getProvider(), model: servedBy, requests, ...turn });
                    await this.usage.attachToLastReply(sessionId, startId, summary());
                } catch (e) {
                    console.error("[usage] couldn't record usage:", e);
                }
            }
        }
    }
}
