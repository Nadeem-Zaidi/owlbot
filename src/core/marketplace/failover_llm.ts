import { ChatRunOptions, ILLM } from "../../interfaces/illm";
import { LLMMessage } from "../../types/llm_message";
import { RETRYABLE_CODES, Route, Router } from "./router";

// A marketplace model in the chat, served by the first route that works:
// if a provider fails before the reply starts (rate limit, outage, bad key),
// the next one takes over. Once text or a tool call has streamed, no retry —
// so nothing is duplicated.
export class FailoverLLM implements ILLM {
    constructor(
        private modelId: string,
        // Looked up per turn: the chat's last provider is kept first (prompt caching).
        private routesFor: (sessionId: string | null) => Promise<Route[]>,
        private build: (route: Route) => ILLM,
        private router: Router | null,
    ) {}

    chat(): Promise<never> { throw new Error("Method not implemented."); }
    async summarizeChat(message: any, userId: string, sessionId: string) {
        const [route] = await this.routesFor(sessionId);
        if (!route) throw new Error("No provider available");
        return this.build(route).summarizeChat(message, userId, sessionId);
    }
    getProvider() { return "marketplace"; }
    getModel() { return this.modelId; }
    getModels() { return [this.modelId]; }
    supportsTools() { return true; }

    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string, apiKey: string, signal: AbortSignal, _model?: string, run?: ChatRunOptions): AsyncGenerator<LLMMessage, void, unknown> {
        const routes = await this.routesFor(sessionId);
        if (!routes.length) {
            const text = `"${this.modelId}" isn't available right now — try another model.`;
            yield { type: "error", code: "upstream_unavailable", message: text, content: [{ type: "upstream_unavailable", text }] } as unknown as LLMMessage;
            return;
        }
        let lastError: LLMMessage | null = null;
        for (let i = 0; i < routes.length; i++) {
            const route = routes[i];
            // The user's message is stored by the first attempt; retries reuse the stored history.
            const input = i === 0 ? messages : [];
            let started = false;
            let failed = false;
            const startedAt = Date.now();
            let firstMs: number | undefined;
            for await (const chunk of this.build(route).chatStream(input, userId, sessionId, apiKey, signal, route.upstreamModel, run)) {
                const c = chunk as any;
                if (firstMs === undefined && (c.type === "message" || c.type === "function_call")) firstMs = Date.now() - startedAt;
                if (!started && c.type === "error" && RETRYABLE_CODES.has(String(c.code)) && i < routes.length - 1 && !signal.aborted) {
                    this.router?.failure(route);
                    lastError = chunk;
                    failed = true;
                    break;
                }
                if (c.type === "message" || c.type === "function_call" || c.type === "session_title") started = true;
                if (c.type === "error" && !started && RETRYABLE_CODES.has(String(c.code))) this.router?.failure(route);
                yield chunk;
            }
            if (!failed) {
                if (started) this.router?.success(route, sessionId, firstMs);
                return;
            }
        }
        if (lastError) yield lastError;
    }
}
