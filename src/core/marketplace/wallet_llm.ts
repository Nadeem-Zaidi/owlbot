import { ChatRunOptions, ILLM } from "../../interfaces/illm";
import { LLMMessage, Tool } from "../../types/llm_message";
import { MarketplaceService } from "./marketplace_service";
import { Route, Router } from "./router";

// Marketplace models in the chat: checks the user has credits before a turn
// and charges each model call (the reply, titles, summaries) as it reports
// its usage, at the price of the provider that served it — own provider:
// tokens × its price; OpenRouter: the exact cost it reports; otherwise an
// estimate from the tokens and the catalogue price.
export class WalletLLM implements ILLM {
    constructor(private inner: ILLM, private market: MarketplaceService, private route?: Route, private modelId?: string) {}

    chat(messages: LLMMessage[], tools: Tool[]) { return this.inner.chat(messages, tools); }
    summarizeChat(message: any, userId: string, sessionId: string) { return this.inner.summarizeChat(message, userId, sessionId); }
    getProvider() { return this.inner.getProvider(); }
    getModel() { return this.inner.getModel(); }
    getModels() { return this.inner.getModels?.() ?? [this.inner.getModel()]; }
    supportsTools() { return this.inner.supportsTools(); }

    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string, apiKey: string, signal: AbortSignal, model?: string, run?: ChatRunOptions): AsyncGenerator<LLMMessage, void, unknown> {
        const blocked = await this.market.blockedReason(userId);
        if (blocked) {
            yield { type: "error", code: "insufficient_credits", message: blocked, content: [{ type: "insufficient_credits", text: blocked }] } as unknown as LLMMessage;
            return;
        }
        const chosen = this.modelId ?? model ?? this.inner.getModel();
        const catalogModel = await this.market.catalog.get(chosen).catch(() => null);
        for await (const chunk of this.inner.chatStream(messages, userId, sessionId, apiKey, signal, model, run)) {
            if ((chunk as any).type === "usage_increment") {
                const inc = chunk as any;
                const u = inc.usage ?? {};
                const input = Number(u.input_tokens ?? 0), output = Number(u.output_tokens ?? 0), cached = Number(u.cache_read_tokens ?? 0);
                const fromRoute = this.route ? Router.costUsd(this.route, { prompt: input + cached, completion: output, cached }, inc.cost_usd) : null;
                const cost = fromRoute ?? (typeof inc.cost_usd === "number" ? inc.cost_usd : this.market.estimateUsd(catalogModel, input, output, cached));
                await this.market.chargeUsage({
                    userId, sessionId, model: this.modelId ?? inc.model ?? chosen, upstreamUsd: cost, source: "chat",
                    provider: this.route?.providerName ?? null, markupPct: this.route?.prices?.markupPct ?? null,
                    inputTokens: input + cached, outputTokens: output,
                })
                    .catch((err) => console.error("[marketplace] couldn't charge a chat call:", err));
            }
            yield chunk;
        }
    }
}
