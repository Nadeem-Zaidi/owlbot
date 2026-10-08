import Anthropic from "@anthropic-ai/sdk";
import { ChatRunOptions, ILLM, ToolSource } from "../interfaces/illm";
import { ContentPart, FileInput, ImageBase64Content, ImageUrlContent, LLMMessage, TextContent, Tool } from "../types/llm_message";
import { LLMResponse } from "../types/llm_response";
import { LLMConfig } from "../types/lmconfig";
import { LLMTool } from "../tools/tool_registry";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { MessageService } from "../service/message_service";
import { ToolDefinition } from "../types/type";
import { contextEngine } from "../core/context";
import { estimatedUsageIncrement, usageIncrement } from "./usage_tracking";
import { TokenCounts } from "../repository/usage_repository";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

const TITLE_PROMPT = `
You are an expert conversation title generator.

Your task is to generate a short, meaningful, and descriptive title that summarizes the user's message or conversation.

Rules:
- Return only the title.
- Do not include quotes or explanations.
- Use 4 to 8 words whenever possible.
- Focus on the main topic or intent.
- Preserve important technical terms, product names, and acronyms.
- Make the title specific and searchable.
- Use Title Case.
- Maximum 60 characters.

Examples:
User: "Can you explain how rotary positional embeddings work?"
Title: Rotary Positional Embeddings Explained

User: "What GPU do I need to run DeepSeek V3?"
Title: DeepSeek V3 GPU Requirements

User: "How does attention use query key and value matrices?"
Title: Query Key Value Attention

User: "I want to build an LLM from scratch"
Title: Building an LLM From Scratch

Return only the generated title.
`.trim();

export class AnthropicProvider implements ILLM {
    private client: Anthropic;
    private config: LLMConfig;
    private messageService: MessageService;
    private tools: LLMTool;
    private readonly RAG_TOOL_NAME = "search_knowledge_base";
    // Claude Opus 5.5 defaults to "medium" effort; set it explicitly so the
    // behaviour doesn't shift silently. Set ANTHROPIC_EFFORT="" to omit it.
    // Only sent to models that accept it (see supportsEffort).
    private readonly effort = process.env.ANTHROPIC_EFFORT ?? "medium";
    // Server-side refusal fallback: if the safety classifiers decline a
    // request, the API re-runs it on Anthropic's recommended fallback model
    // instead of returning a refusal. Claude API only — set
    // ANTHROPIC_ENABLE_FALLBACKS=false on Bedrock/Vertex/Foundry.
    private readonly enableFallbacks = (process.env.ANTHROPIC_ENABLE_FALLBACKS ?? "true") !== "false";
    private static readonly FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

    // Haiku 4.5 and older Sonnets reject `output_config.effort` with a 400.
    private supportsEffort(model: string): boolean {
        return /^claude-(opus|fable|mythos)-|^claude-sonnet-(5|4-6)/.test(model);
    }

    private requestOptions(model: string, effort: string = this.effort) {
        return {
            ...(effort && this.supportsEffort(model)
                ? { output_config: { effort: effort as Anthropic.Beta.BetaOutputConfig["effort"] } }
                : {}),
            ...(this.enableFallbacks && AnthropicProvider.FALLBACK_MODELS.has(model)
                ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
                : {}),
        };
    }

    constructor(apiKey: string, config: LLMConfig, messageService: MessageService, tools: LLMTool) {
        this.config = config;
        this.client = new Anthropic({ apiKey });
        this.messageService = messageService;
        this.tools = tools;
    }

    supportsTools(): boolean {
        return true;
    }

    chat(messages: LLMMessage[], tools?: Tool[]): Promise<LLMResponse> {
        throw new Error("Method not implemented.");
    }

    // Converts the stored, provider-neutral history into Messages API shape.
    // System messages go to the top-level `system` param, tool calls become
    // assistant tool_use blocks, tool outputs become user tool_result blocks,
    // and consecutive same-role entries are merged into a single turn so
    // parallel tool calls/results replay as one assistant + one user message.
    private fromInput(messages: LLMMessage[]): { system: string; messages: MessageParam[] } {
        const systemParts: string[] = [];
        const out: MessageParam[] = [];

        // A tool_use without its tool_result (or vice-versa) is a 400, so drop
        // any half-saved pair, e.g. from a request that died mid-tool-call.
        const callIds = new Set(messages.filter((m) => m.role === "tool_call").map((m) => m.tool_call_id));
        const outputIds = new Set(messages.filter((m) => m.role === "tool_call_output").map((m) => m.tool_call_id));

        const push = (role: "user" | "assistant", blocks: ContentBlockParam[]) => {
            if (!blocks.length) return;
            const last = out[out.length - 1];
            if (last && last.role === role && Array.isArray(last.content)) {
                (last.content as ContentBlockParam[]).push(...blocks);
            } else {
                out.push({ role, content: [...blocks] });
            }
        };

        for (const m of messages) {
            switch (m.role) {
                case "system":
                    systemParts.push(...this.textParts(m.content));
                    break;

                case "user":
                    push("user", this.userBlocks(m.content));
                    break;

                case "assistant": {
                    const text = this.textParts(m.content).join("");
                    if (text) push("assistant", [{ type: "text", text }]);
                    break;
                }

                case "tool_call": {
                    if (!m.tool_call_id || !outputIds.has(m.tool_call_id)) break;
                    let input: unknown = m.arguments ?? {};
                    if (typeof input === "string") {
                        try { input = JSON.parse(input); } catch { input = {}; }
                    }
                    push("assistant", [{ type: "tool_use", id: m.tool_call_id, name: m.name ?? "", input }]);
                    break;
                }

                case "tool_call_output": {
                    if (!m.tool_call_id || !callIds.has(m.tool_call_id)) break;
                    push("user", [{
                        type: "tool_result",
                        tool_use_id: m.tool_call_id,
                        content: typeof m.output === "string" ? m.output : JSON.stringify(m.output ?? ""),
                    }]);
                    break;
                }

                default:
                    push("user", [{ type: "text", text: "[unreadable message]" }]);
            }
        }

        return { system: systemParts.join("\n\n"), messages: out };
    }

    private textParts(content: LLMMessage["content"]): string[] {
        if (typeof content === "string") return content ? [content] : [];
        if (!Array.isArray(content)) return [];
        return (content as ContentPart[])
            .filter((p) => ["text", "output_text", "input_text"].includes(p.type) && typeof (p as TextContent).text === "string")
            .map((p) => (p as TextContent).text);
    }

    private userBlocks(content: LLMMessage["content"]): ContentBlockParam[] {
        if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
        if (!Array.isArray(content)) return [];

        return (content as ContentPart[]).map((part): ContentBlockParam => {
            switch (part.type) {
                case "text":
                case "input_text":
                    return { type: "text", text: (part as TextContent).text };

                case "input_base64_image": {
                    const img = part as ImageBase64Content;
                    return { type: "image", source: { type: "base64", media_type: img.source.media_type, data: img.source.data } };
                }

                case "input_url_image":
                    return { type: "image", source: { type: "url", url: (part as ImageUrlContent).image_url.url } };

                case "input_file": {
                    const file = part as FileInput;
                    const name = file.fileName ?? file.file_id ?? "file";
                    const isPdf = (file.fileExtension ?? name).toLowerCase().endsWith("pdf");
                    if (isPdf && file.fileUrl) {
                        return { type: "document", source: { type: "url", url: file.fileUrl }, title: name };
                    }
                    // Claude reads PDFs, images and text natively; other file
                    // types (spreadsheets etc.) only reach the model by name.
                    return { type: "text", text: `[Attached file: ${name}${file.fileUrl ? ` (${file.fileUrl})` : ""}]` };
                }

                default:
                    throw new Error(`Unsupported content type: ${part.type}`);
            }
        });
    }

    private toolDefinitions(toolset: ToolSource): Anthropic.Beta.BetaTool[] {
        return toolset.getAll().map((def) => ({
            name: def.name,
            description: def.description,
            input_schema: def.parameters as Anthropic.Beta.BetaTool.InputSchema,
            // Stream tool input as it's generated rather than in one burst.
            // The API no longer validates it, so validateToolInput() does.
            eager_input_streaming: true,
        }));
    }

    // With eager input streaming the SDK's tolerant parser can hand back a
    // truncated object, so make sure every required field is present before
    // running the tool.
    private validateToolInput(toolset: ToolSource, name: string, input: unknown): string | null {
        if (!input || typeof input !== "object" || Array.isArray(input)) return "tool input is not an object";
        const def: ToolDefinition | undefined = toolset.getAll().find((d) => d.name === name);
        const required: string[] = (def?.parameters as { required?: string[] } | undefined)?.required ?? [];
        const missing = required.filter((k) => !(k in (input as Record<string, unknown>)));
        return missing.length ? `missing required field(s): ${missing.join(", ")}` : null;
    }

    // One-shot completion for the context engine's summaries (provider's default model, like titles).
    private async summarizeText(system: string, text: string): Promise<{ text: string; usage?: TokenCounts; model?: string }> {
        const response = await this.client.beta.messages.create({
            model: this.config.model,
            max_tokens: 2000,
            system,
            ...this.requestOptions(this.config.model, "low"),
            messages: [{ role: "user", content: text }],
        });
        const out = response.content
            .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
        return { text: out, usage: anthropicUsage(response.usage), model: response.model };
    }

    async summarizeChat(transcript: string): Promise<string> {
        return (await this.generateTitle(transcript)).title;
    }

    // Also returns the tokens it used, so chatStream can report them.
    private async generateTitle(transcript: string): Promise<{ title: string; usage?: TokenCounts; model?: string }> {
        try {
            const response = await this.client.beta.messages.create({
                model: this.config.model,
                max_tokens: 2000,
                system: TITLE_PROMPT,
                ...this.requestOptions(this.config.model, "low"),
                messages: [{ role: "user", content: transcript }],
            });
            const text = response.content
                .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
                .map((b) => b.text)
                .join("")
                .trim();
            return { title: text || "New Conversation", usage: anthropicUsage(response.usage), model: response.model };
        } catch (error) {
            console.error("Failed to generate title:", error);
            return { title: "New Conversation" };
        }
    }

    // `_apiKey` is accepted to satisfy ILLM (the OpenAI provider uses it for
    // raw fetch calls); this provider authenticates with the key it was
    // constructed with.
    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string, _apiKey: string, signal: AbortSignal, model?: string, run?: ChatRunOptions): AsyncGenerator<LLMMessage, void, unknown> {
        const activeModel = model ?? this.config.model;
        const toolset: ToolSource = run?.tools ?? this.tools;
        await this.messageService.runTransaction(sessionId, messages);
        const userSessionMessages = await this.messageService.loadMessages(sessionId);
        // The context engine picks what part of the stored history is sent
        // (recent messages + a summary of older ones); everything stays stored.
        const context = await contextEngine().assemble(userSessionMessages, {
            sessionId, userId, skillScope: run?.skillScope, model: activeModel, summarize: (system, text) => this.summarizeText(system, text),
        });
        for (const u of context.usage) yield usageIncrement(u.usage, u.model, "compaction");
        const { system: storedSystem, messages: history } = this.fromInput(context.messages);
        const system = [run?.systemPrompt, storedSystem].filter(Boolean).join("\n\n");
        const tools = this.toolDefinitions(toolset);

        const isFirstExchange = userSessionMessages.filter((m) => m.role === "user").length === 1;
        let titleGenerated = false;
        const collectedSources = new Set<string>();
        let jsonRetries = 0;

        while (true) {
            if (signal.aborted) {
                yield { type: "cancelled", content: [{ type: "aborted", text: "Request cancelled." }] };
                return;
            }

            let message: Anthropic.Beta.BetaMessage;
            // Text streamed so far this turn — saved if the user presses Stop.
            let streamedText = "";
            try {
                const stream = this.client.beta.messages.stream({
                    model: activeModel,
                    max_tokens: this.config.maxTokens,
                    ...(system ? { system } : {}),
                    messages: history,
                    ...(tools.length ? { tools } : {}),
                    ...this.requestOptions(activeModel),
                }, { signal });

                for await (const event of stream) {
                    if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
                        yield {
                            id: event.content_block.id,
                            name: event.content_block.name,
                            type: "function_call",
                            tool_call_id: event.content_block.id,
                        } as LLMMessage;
                    }
                    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                        streamedText += event.delta.text;
                        yield {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "text", text: event.delta.text }] as ContentPart[],
                        };
                    }
                }

                message = await stream.finalMessage();
                jsonRetries = 0;
                yield usageIncrement(anthropicUsage(message.usage), message.model);
            } catch (err) {
                const errorChunk = this.toErrorChunk(err, signal);
                // finalMessage() rejects with a plain (non-API) error when a
                // streamed tool input isn't parseable JSON — re-issue the turn.
                if (!errorChunk && jsonRetries++ < 2) {
                    console.warn("[AnthropicProvider] tool input was not parseable JSON, re-issuing the turn");
                    continue;
                }
                if (!errorChunk) console.error("[AnthropicProvider] chatStream request threw:", err);
                if (signal.aborted) {
                    // Stopped mid-reply: the input and the text so far were still billed.
                    yield estimatedUsageIncrement(JSON.stringify(history).length + system.length + JSON.stringify(tools).length, streamedText.length, activeModel);
                    if (streamedText) await this.savePartialReply(sessionId, streamedText, activeModel);
                }
                yield errorChunk ?? { type: "error", code: "error", message: "Unexpected error.", content: [{ type: "error", text: "Unexpected error." }] };
                return;
            }

            const text = message.content
                .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
                .map((b) => b.text)
                .join("");

            if (text) {
                try {
                    const assistantMessage: LLMMessage = {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text }],
                        sources: collectedSources.size ? Array.from(collectedSources) : undefined,
                        // The turn's total token usage is added by UsageTrackingLLM.
                        metadata: { provider: "anthropic", model: message.model ?? activeModel },
                    };
                    await this.messageService.createLLMMessage(sessionId, assistantMessage);

                    if (isFirstExchange && !titleGenerated) {
                        titleGenerated = true;
                        const firstUserText = this.textParts(messages[0]?.content).join("\n");
                        const generated = await this.generateTitle(`User: ${firstUserText}\n\nAssistant: ${text}`);
                        if (generated.usage) yield usageIncrement(generated.usage, generated.model, "title");
                        const title = generated.title;
                        await this.messageService.updateTitle(sessionId, userId, title);
                        yield { type: "session_title", content: title };
                    }
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    yield { type: "error", code: "error", message: `Error in generating response: ${errMsg}`, error: "Error in generating response", isDone: true };
                }
            }

            if (message.stop_reason === "refusal") {
                const reason = message.stop_details?.explanation ?? "Claude declined to respond to this request.";
                yield { type: "error", code: "refusal", message: reason, content: [{ type: "refusal", text: reason }] };
                return;
            }

            const toolUses = message.content.filter(
                (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
            );

            if (message.stop_reason === "pause_turn") {
                history.push({ role: "assistant", content: message.content });
                continue;
            }

            if (!toolUses.length) {
                if (message.stop_reason === "max_tokens") {
                    yield { type: "error", code: "max_tokens", message: "Response was cut off (max_tokens reached).", content: [{ type: "max_tokens", text: "Response was cut off (max_tokens reached)." }] };
                }
                yield { content: "", isDone: true, sources: collectedSources.size ? Array.from(collectedSources) : undefined };
                return;
            }

            // A tool input cut off at max_tokens can still look like a valid
            // object; never run tools on it.
            if (message.stop_reason === "max_tokens") {
                yield { type: "error", code: "max_tokens", message: "Tool call was truncated. Try raising ANTHROPIC_MAX_TOKENS.", content: [{ type: "max_tokens", text: "Tool call was truncated." }] };
                return;
            }

            // Append the full content (thinking blocks included) — Claude needs
            // them echoed back unchanged to continue the turn after tool use.
            history.push({ role: "assistant", content: message.content });

            const db = await this.messageService.rawDb() as unknown as IDatabaseAdapter;
            const toolCalls: LLMMessage[] = [];
            const toolOutputs: LLMMessage[] = [];
            const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];

            for (const toolUse of toolUses) {
                const args = (toolUse.input ?? {}) as Record<string, any>;
                yield {
                    type: "function_call_arguments",
                    tool_call_id: toolUse.id,
                    arguments: JSON.stringify(args),
                } as unknown as LLMMessage;

                let result: string;
                let isError = false;
                try {
                    const invalid = this.validateToolInput(toolset, toolUse.name, args);
                    if (invalid) throw new Error(`Invalid arguments for "${toolUse.name}": ${invalid}`);

                    const toolOutput = await toolset.executeTool(toolUse.name, args, { db, userId, sessionId });
                    result = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);
                    yield { type: "function_call_output", tool_call_id: toolUse.id, output: result } as LLMMessage;

                    if (toolUse.name === this.RAG_TOOL_NAME) {
                        const sources = this.extractSources(toolOutput);
                        if (sources.length) {
                            sources.forEach((s) => collectedSources.add(s));
                            yield { type: "sources", tool_call_id: toolUse.id, sources: Array.from(collectedSources) } as unknown as LLMMessage;
                        }
                    }
                } catch (toolErr) {
                    isError = true;
                    const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                    result = JSON.stringify({
                        error: true,
                        message: errMsg,
                        hint: "Tool execution failed. Do not retry with the same arguments.",
                    });
                    yield { type: "function_call_output", tool_call_id: toolUse.id, error: result } as LLMMessage;
                }

                toolCalls.push({ role: "tool_call", type: "tool_call", tool_call_id: toolUse.id, name: toolUse.name, arguments: args });
                toolOutputs.push({ role: "tool_call_output", type: "tool_call_output", tool_call_id: toolUse.id, output: result });
                toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result, ...(isError ? { is_error: true } : {}) });
            }

            // Calls first, then outputs, so the stored history replays as one
            // assistant turn of tool_use blocks followed by one user turn of results.
            try {
                await this.messageService.runTransaction(sessionId, [...toolCalls, ...toolOutputs]);
            } catch (dbErr) {
                const dbErrMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
                yield { type: "error", code: "error", message: `Something went wrong while saving the tool result: ${dbErrMsg}`, error: "Something went wrong while saving the tool result. Please try again." } as LLMMessage;
                return;
            }

            // All results go back in a single user message.
            history.push({ role: "user", content: toolResults });
        }
    }

    // Keeps what the user already saw on screen when they pressed Stop, so a
    // reload shows the same partial answer instead of nothing.
    private async savePartialReply(sessionId: string, text: string, model: string): Promise<void> {
        try {
            await this.messageService.createLLMMessage(sessionId, {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text }],
                metadata: { provider: "anthropic", model, cancelled: true },
            });
        } catch (err) {
            console.error("[AnthropicProvider] failed to save partial reply:", err);
        }
    }

    private extractSources(toolOutput: unknown): string[] {
        try {
            const parsed = typeof toolOutput === "string" ? JSON.parse(toolOutput) : toolOutput;
            // search_knowledge_base returns { results: [...] }.
            const results = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : parsed ? [parsed] : [];
            return [...new Set<string>(results
                .map((r: any) => r?.source_file)
                .filter((f: unknown): f is string => typeof f === "string" && f.length > 0))];
        } catch {
            return [];
        }
    }

    // Returns null for errors that aren't from the API (e.g. a JSON parse
    // failure on streamed tool input), so the caller can decide to retry.
    private toErrorChunk(err: unknown, signal: AbortSignal): LLMMessage | null {
        const chunk = (code: string, message: string): LLMMessage => ({ type: "error", code, message, content: [{ type: code, text: message }] });

        if (signal.aborted || err instanceof Anthropic.APIUserAbortError) {
            return { type: "cancelled", content: [{ type: "aborted", text: "Request cancelled." }] };
        }
        if (err instanceof Anthropic.AuthenticationError) return chunk("auth", "Invalid API key.");
        if (err instanceof Anthropic.PermissionDeniedError) return chunk("permission", "Access denied.");
        if (err instanceof Anthropic.RateLimitError) return chunk("rate_limit", "Rate limit hit. Please wait and retry.");
        if (err instanceof Anthropic.InternalServerError) return chunk("server", "Anthropic server error. Try again shortly.");
        if (err instanceof Anthropic.APIConnectionTimeoutError) return chunk("timeout", "Request timed out.");
        if (err instanceof Anthropic.APIConnectionError) return chunk("network", "Could not reach Anthropic. Check your connection.");
        if (err instanceof Anthropic.APIError) {
            console.error(`[AnthropicProvider] API returned ${err.status}:`, err.message);
            return chunk("error", err.message);
        }
        return null;
    }

    getProvider(): string {
        return "anthropic";
    }

    getModel(): string {
        return this.config.model;
    }

    getModels(): string[] {
        return this.config.models ?? [this.config.model];
    }
}

// Claude reports cached input separately from regular input.
function anthropicUsage(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): TokenCounts {
    return {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
        cache_write_tokens: u.cache_creation_input_tokens ?? 0,
    };
}
