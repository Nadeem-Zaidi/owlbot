import { ChatRunOptions, ILLM, ToolSource } from "../interfaces/illm";
import { ContentPart, FileInput, ImageBase64Content, ImageUrlContent, LLMMessage, TextContent, Tool } from "../types/llm_message";
import { LLMResponse } from "../types/llm_response";
import { LLMConfig } from "../types/lmconfig";
import { LLMTool } from "../tools/tool_registry";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { MessageService } from "../service/message_service";
import { contextEngine } from "../core/context";
import { estimatedUsageIncrement, usageIncrement } from "./usage_tracking";
import { TokenCounts } from "../repository/usage_repository";
import { assertPublicUrl } from "../service/agents/url_guard";

// Any service that speaks OpenAI's Chat Completions API: OpenRouter, Groq,
// DeepSeek, Mistral, Together, Fireworks, a local Ollama / LM Studio, …
// Used for users' own keys (BYOK). Supports streaming, tool calls (the
// knowledge base search, agent functions) and images; OpenAI-only extras
// like the hosted code interpreter aren't available here.

type ChatMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string | Array<Record<string, unknown>> }
    | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
    | { role: "tool"; tool_call_id: string; content: string };

type WireToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

const TITLE_PROMPT = "Write a short, specific title (4–8 words, Title Case, max 60 characters) for this conversation. Return only the title, no quotes.";
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TOOL_ROUNDS = 12;

export class ProviderHttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

export class OpenAICompatibleProvider implements ILLM {
    private readonly RAG_TOOL_NAME = "search_knowledge_base";
    private readonly baseUrl: string;

    constructor(
        private apiKey: string,
        baseUrl: string,
        private config: LLMConfig,
        private messageService: MessageService,
        private tools: LLMTool,
        // Shown in usage reports, e.g. "openrouter" / "groq".
        private providerName = "openai_compatible",
    ) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }

    supportsTools(): boolean { return true; }
    getProvider(): string { return this.providerName; }
    getModel(): string { return this.config.model; }
    getModels(): string[] { return this.config.models ?? [this.config.model]; }
    chat(_m: LLMMessage[], _t?: Tool[]): Promise<LLMResponse> { throw new Error("Method not implemented."); }

    async summarizeChat(transcript: string): Promise<string> {
        return (await this.generateTitle(transcript)).title;
    }

    private headers(): Record<string, string> {
        return {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            // OpenRouter uses these to attribute traffic; other services ignore them.
            "X-Title": "Owl Bot",
            ...(process.env.WEB_APP_URL ? { "HTTP-Referer": process.env.WEB_APP_URL } : {}),
        };
    }

    // ── history → Chat Completions messages ──
    private fromInput(messages: LLMMessage[]): ChatMessage[] {
        const out: ChatMessage[] = [];
        const callIds = new Set(messages.filter((m) => m.role === "tool_call").map((m) => m.tool_call_id));
        const outputIds = new Set(messages.filter((m) => m.role === "tool_call_output").map((m) => m.tool_call_id));
        const system: string[] = [];

        for (const m of messages) {
            switch (m.role) {
                case "system":
                    system.push(...textParts(m.content));
                    break;
                case "user": {
                    const parts = this.userParts(m.content);
                    if (parts.length) out.push({ role: "user", content: parts });
                    break;
                }
                case "assistant": {
                    const text = textParts(m.content).join("");
                    if (text) out.push({ role: "assistant", content: text });
                    break;
                }
                case "tool_call": {
                    // A call without its result (or vice-versa) is rejected — skip half pairs.
                    if (!m.tool_call_id || !outputIds.has(m.tool_call_id)) break;
                    const args = typeof m.arguments === "string" ? m.arguments : JSON.stringify(m.arguments ?? {});
                    const call: WireToolCall = { id: m.tool_call_id, type: "function", function: { name: m.name ?? "", arguments: args } };
                    const last = out[out.length - 1];
                    // Parallel calls replay as one assistant message.
                    if (last && last.role === "assistant" && last.tool_calls && !last.content) last.tool_calls.push(call);
                    else out.push({ role: "assistant", content: null, tool_calls: [call] });
                    break;
                }
                case "tool_call_output": {
                    if (!m.tool_call_id || !callIds.has(m.tool_call_id)) break;
                    out.push({ role: "tool", tool_call_id: m.tool_call_id, content: typeof m.output === "string" ? m.output : JSON.stringify(m.output ?? "") });
                    break;
                }
            }
        }
        return system.length ? [{ role: "system", content: system.join("\n\n") }, ...out] : out;
    }

    private userParts(content: LLMMessage["content"]): Array<Record<string, unknown>> {
        if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
        if (!Array.isArray(content)) return [];
        return (content as ContentPart[]).map((part): Record<string, unknown> => {
            switch (part.type) {
                case "text":
                case "input_text":
                    return { type: "text", text: (part as TextContent).text };
                case "input_base64_image": {
                    const img = part as ImageBase64Content;
                    return { type: "image_url", image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` } };
                }
                case "input_url_image":
                    return { type: "image_url", image_url: { url: (part as ImageUrlContent).image_url.url } };
                case "input_file": {
                    const f = part as FileInput;
                    const name = f.fileName ?? f.file_id ?? "file";
                    // Document text (Word, Excel, …) is already added as a text part upstream.
                    return { type: "text", text: `[Attached file: ${name}${f.fileUrl ? ` (${f.fileUrl})` : ""}]` };
                }
                default:
                    return { type: "text", text: `[${part.type}]` };
            }
        });
    }

    private toolDefinitions(toolset: ToolSource) {
        return toolset.getAll().map((def) => ({
            type: "function" as const,
            function: { name: def.name, description: def.description, parameters: def.parameters },
        }));
    }

    // ── one streamed completion ──
    // Yields text deltas as they arrive; returns the full turn at the end.
    private async *streamOnce(body: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<
        { delta: string },
        { text: string; toolCalls: WireToolCall[]; finishReason: string | null; usage: TokenCounts | null; model: string | null }
    > {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(body),
            signal: AbortSignal.any([signal, timeout]),
        });
        if (!res.ok || !res.body) {
            const detail = await res.text().catch(() => "");
            throw new ProviderHttpError(res.status, errorMessage(res.status, detail));
        }

        let text = "";
        let finishReason: string | null = null;
        let usage: TokenCounts | null = null;
        let model: string | null = null;
        const calls = new Map<number, WireToolCall>();
        const decoder = new TextDecoder();
        let buffer = "";

        const reader = res.body.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let nl: number;
                while ((nl = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (!line.startsWith("data:")) continue;
                    const data = line.slice(5).trim();
                    if (!data || data === "[DONE]") continue;
                    let evt: any;
                    try { evt = JSON.parse(data); } catch { continue; }
                    if (evt.error) throw new ProviderHttpError(500, String(evt.error.message ?? evt.error));
                    if (evt.model) model = evt.model;
                    if (evt.usage) usage = toCounts(evt.usage);
                    const choice = evt.choices?.[0];
                    if (!choice) continue;
                    const delta = choice.delta ?? {};
                    if (typeof delta.content === "string" && delta.content) {
                        text += delta.content;
                        yield { delta: delta.content };
                    }
                    for (const tc of delta.tool_calls ?? []) {
                        const idx = typeof tc.index === "number" ? tc.index : calls.size;
                        const cur = calls.get(idx) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
                        if (tc.id) cur.id = tc.id;
                        if (tc.function?.name) cur.function.name += tc.function.name;
                        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
                        calls.set(idx, cur);
                    }
                    if (choice.finish_reason) finishReason = choice.finish_reason;
                }
            }
        } finally {
            reader.releaseLock();
        }
        const toolCalls = [...calls.values()].filter((c) => c.function.name).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
        return { text, toolCalls, finishReason, usage, model };
    }

    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string, _apiKey: string, signal: AbortSignal, model?: string, run?: ChatRunOptions): AsyncGenerator<LLMMessage, void, unknown> {
        const activeModel = model ?? this.config.model;
        const toolset: ToolSource = run?.tools ?? this.tools;

        // Re-checked on every request: a hostname could start resolving to a
        // private address after the key was saved.
        try {
            await assertPublicUrl(this.baseUrl);
        } catch (err) {
            yield errorChunk("blocked_url", err instanceof Error ? err.message : "That address isn't allowed.");
            return;
        }

        await this.messageService.runTransaction(sessionId, messages);
        const stored = await this.messageService.loadMessages(sessionId);
        // The context engine picks what part of the stored history is sent
        // (recent messages + a summary of older ones); everything stays stored.
        const context = await contextEngine().assemble(stored, {
            sessionId, userId, skillScope: run?.skillScope, model: activeModel, summarize: (system, text) => this.summarizeText(system, text, activeModel),
        });
        for (const u of context.usage) yield usageIncrement(u.usage, u.model, "compaction");
        const history = this.fromInput(context.messages);
        if (run?.systemPrompt) {
            if (history[0]?.role === "system") history[0] = { role: "system", content: `${run.systemPrompt}\n\n${history[0].content}` };
            else history.unshift({ role: "system", content: run.systemPrompt });
        }
        let tools = this.toolDefinitions(toolset);
        const isFirstExchange = stored.filter((m) => m.role === "user").length === 1;
        let titleDone = false;
        const sources = new Set<string>();
        let includeUsage = true;
        let sendMaxTokens = true;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (signal.aborted) {
                yield { type: "cancelled", content: [{ type: "aborted", text: "Request cancelled." }] };
                return;
            }
            const body: Record<string, unknown> = {
                model: activeModel,
                messages: history,
                stream: true,
                ...(sendMaxTokens ? { max_tokens: this.config.maxTokens } : {}),
                ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
                ...(tools.length ? { tools } : {}),
            };

            let turn: { text: string; toolCalls: WireToolCall[]; finishReason: string | null; usage: TokenCounts | null; model: string | null };
            let streamed = "";
            try {
                const gen = this.streamOnce(body, signal);
                while (true) {
                    const step = await gen.next();
                    if (step.done) { turn = step.value; break; }
                    streamed += step.value.delta;
                    yield { type: "message", role: "assistant", content: [{ type: "text", text: step.value.delta }] as ContentPart[] };
                }
            } catch (err) {
                // Some services reject parts of the request: retry once without them.
                if (err instanceof ProviderHttpError && err.status === 400 && !streamed) {
                    const m = err.message.toLowerCase();
                    if (includeUsage && m.includes("stream_options")) { includeUsage = false; round--; continue; }
                    if (sendMaxTokens && /max_tokens|max_completion_tokens|maximum.*tokens/.test(m)) { sendMaxTokens = false; round--; continue; }
                    if (tools.length && /tool|function/.test(m)) {
                        tools = [];
                        round--;
                        continue;
                    }
                }
                if (signal.aborted) {
                    // Stopped mid-reply: the input and the text so far were still billed.
                    yield estimatedUsageIncrement(JSON.stringify(body).length, streamed.length, activeModel);
                    if (streamed) await this.savePartial(sessionId, streamed, activeModel);
                    yield { type: "cancelled", content: [{ type: "aborted", text: "Request cancelled." }] };
                    return;
                }
                yield toErrorChunk(err);
                return;
            }

            if (turn.usage) yield usageIncrement(turn.usage, turn.model ?? activeModel);

            if (turn.text) {
                await this.messageService.createLLMMessage(sessionId, {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: turn.text }],
                    sources: sources.size ? [...sources] : undefined,
                    metadata: { provider: this.providerName, model: turn.model ?? activeModel },
                });
                if (isFirstExchange && !titleDone) {
                    titleDone = true;
                    const first = textParts(messages[0]?.content).join("\n");
                    const t = await this.generateTitle(`User: ${first}\n\nAssistant: ${turn.text}`, activeModel);
                    if (t.usage) yield usageIncrement(t.usage, activeModel, "title");
                    await this.messageService.updateTitle(sessionId, userId, t.title);
                    yield { type: "session_title", content: t.title };
                }
            }

            if (!turn.toolCalls.length) {
                if (turn.finishReason === "length") {
                    yield errorChunk("max_tokens", "Response was cut off (max_tokens reached).");
                }
                yield { content: "", isDone: true, sources: sources.size ? [...sources] : undefined };
                return;
            }

            history.push({ role: "assistant", content: turn.text || null, tool_calls: turn.toolCalls });
            const db = await this.messageService.rawDb() as unknown as IDatabaseAdapter;
            const calls: LLMMessage[] = [];
            const outputs: LLMMessage[] = [];

            for (const call of turn.toolCalls) {
                let args: Record<string, any> = {};
                try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
                yield { id: call.id, name: call.function.name, type: "function_call", tool_call_id: call.id } as LLMMessage;
                yield { type: "function_call_arguments", tool_call_id: call.id, arguments: JSON.stringify(args) } as unknown as LLMMessage;

                let result: string;
                try {
                    const output = await toolset.executeTool(call.function.name, args, { db, userId, sessionId });
                    result = typeof output === "string" ? output : JSON.stringify(output);
                    yield { type: "function_call_output", tool_call_id: call.id, output: result } as LLMMessage;
                    if (call.function.name === this.RAG_TOOL_NAME) {
                        for (const s of extractSources(output)) sources.add(s);
                        if (sources.size) yield { type: "sources", tool_call_id: call.id, sources: [...sources] } as unknown as LLMMessage;
                    }
                } catch (toolErr) {
                    result = JSON.stringify({ error: true, message: toolErr instanceof Error ? toolErr.message : String(toolErr), hint: "Tool execution failed. Do not retry with the same arguments." });
                    yield { type: "function_call_output", tool_call_id: call.id, error: result } as LLMMessage;
                }
                calls.push({ role: "tool_call", type: "tool_call", tool_call_id: call.id, name: call.function.name, arguments: args });
                outputs.push({ role: "tool_call_output", type: "tool_call_output", tool_call_id: call.id, output: result });
                history.push({ role: "tool", tool_call_id: call.id, content: result });
            }
            try {
                await this.messageService.runTransaction(sessionId, [...calls, ...outputs]);
            } catch (dbErr) {
                yield errorChunk("error", `Couldn't save the tool result: ${dbErr instanceof Error ? dbErr.message : dbErr}`);
                return;
            }
        }
        yield errorChunk("error", "Stopped after too many tool calls in one answer.");
    }

    // One-shot completion for the context engine's summaries. Uses the chat's
    // model: a user's key may only allow the models they listed.
    private async summarizeText(system: string, text: string, model: string): Promise<{ text: string; usage?: TokenCounts; model?: string }> {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: "system", content: system }, { role: "user", content: text }] }),
            signal: AbortSignal.timeout(90_000),
        });
        if (!res.ok) throw new Error(`summary request failed (${res.status})`);
        const json: any = await res.json();
        return { text: String(json.choices?.[0]?.message?.content ?? ""), usage: json.usage ? toCounts(json.usage) : undefined, model: json.model ?? model };
    }

    private async generateTitle(transcript: string, model = this.config.model): Promise<{ title: string; usage?: TokenCounts }> {
        try {
            const res = await fetch(`${this.baseUrl}/chat/completions`, {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify({ model, max_tokens: 40, messages: [{ role: "system", content: TITLE_PROMPT }, { role: "user", content: transcript.slice(0, 4000) }] }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok) return { title: "New Conversation" };
            const json: any = await res.json();
            const title = String(json.choices?.[0]?.message?.content ?? "").replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 80);
            return { title: title || "New Conversation", usage: json.usage ? toCounts(json.usage) : undefined };
        } catch {
            return { title: "New Conversation" };
        }
    }

    private async savePartial(sessionId: string, text: string, model: string) {
        try {
            await this.messageService.createLLMMessage(sessionId, {
                type: "message", role: "assistant", content: [{ type: "output_text", text }],
                metadata: { provider: this.providerName, model, cancelled: true },
            });
        } catch (err) {
            console.error("[OpenAICompatibleProvider] failed to save partial reply:", err);
        }
    }
}

// ── helpers ──
function textParts(content: LLMMessage["content"]): string[] {
    if (typeof content === "string") return content ? [content] : [];
    if (!Array.isArray(content)) return [];
    return (content as ContentPart[])
        .filter((p) => ["text", "output_text", "input_text"].includes(p.type) && typeof (p as TextContent).text === "string")
        .map((p) => (p as TextContent).text);
}

function toCounts(u: any): TokenCounts {
    const cached = Number(u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0) || 0;
    const prompt = Number(u?.prompt_tokens ?? 0) || 0;
    return {
        input_tokens: Math.max(0, prompt - cached),
        output_tokens: Number(u?.completion_tokens ?? 0) || 0,
        cache_read_tokens: cached,
        cache_write_tokens: 0,
    };
}

function extractSources(output: unknown): string[] {
    try {
        const parsed = typeof output === "string" ? JSON.parse(output) : output;
        const results = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.results) ? (parsed as any).results : [];
        return [...new Set<string>(results.map((r: any) => r?.source_file).filter((f: unknown): f is string => typeof f === "string" && !!f))];
    } catch {
        return [];
    }
}

const errorChunk = (code: string, message: string): LLMMessage => ({ type: "error", code, message, content: [{ type: code, text: message }] });

// Human-readable message from a provider's HTTP error (never includes the key).
export function errorMessage(status: number, body: string): string {
    let detail = "";
    try {
        const j = JSON.parse(body);
        detail = String(j?.error?.message ?? j?.message ?? j?.detail ?? "");
    } catch {
        detail = body.slice(0, 200);
    }
    if (status === 401 || status === 403) return `The provider rejected this API key (${status}).${detail ? ` ${detail}` : ""}`;
    if (status === 404) return `Not found at this address (404) — check the base URL and model name.${detail ? ` ${detail}` : ""}`;
    if (status === 429) return `Rate limit or quota reached on your provider account.${detail ? ` ${detail}` : ""}`;
    return `${status}: ${detail || "request failed"}`;
}

function toErrorChunk(err: unknown): LLMMessage {
    if (err instanceof ProviderHttpError) {
        const code = err.status === 401 || err.status === 403 ? "auth" : err.status === 429 ? "rate_limit" : err.status >= 500 ? "server" : "error";
        return errorChunk(code, err.message);
    }
    if (err instanceof Error && (err.name === "TimeoutError")) return errorChunk("timeout", "The provider took too long to answer.");
    console.error("[OpenAICompatibleProvider] request failed:", err);
    return errorChunk("network", "Couldn't reach the provider. Check the base URL.");
}
