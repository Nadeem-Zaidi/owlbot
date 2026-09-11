import OpenAI from "openai";
import type { ResponseFunctionToolCall, ResponseInputFile, ResponseInputImage, ResponseInputItem, ResponseInputText, ResponseOutputText } from "openai/resources/responses/responses";
import { ILLM } from "../interfaces/illm";
import { ContentPart, FileInput, ImageBase64Content, ImageUrlContent, LLMMessage, TextContent, Tool, ToolCall } from "../types/llm_message";
import { LLMResponse } from "../types/llm_response";
import { LLMConfig } from "../types/lmconfig";
import { LLMTool } from "../tools/tool_registry";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { MessageService } from "../service/message_service";
import { IFileStore } from "../interfaces/ifilestore";



export class OpenAIProvider implements ILLM {
    private client: OpenAI;
    private config: LLMConfig;
    private messageService: MessageService;
    private readonly fileStore?: IFileStore;
    private readonly CODE_INTERPRETER_FILE_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
    private abortController: AbortController | null = null;
    private readonly baseUrl = "https://api.openai.com/v1/responses";
    private tools: LLMTool
    private readonly RAG_TOOL_NAME = "search_knowledge_base";
    private readonly enableCodeInterpreter = (process.env.ENABLE_CODE_INTERPRETER ?? "true") !== "false";
    private readonly codeInterpreterMemory = process.env.CODE_INTERPRETER_MEMORY;
    private readonly enableDeepwikiMcp = (process.env.ENABLE_DEEPWIKI_MCP ?? "false") === "true";
    private readonly CONTAINER_REUSE_WINDOW_MS = 19 * 60 * 1000;



    constructor(apiKey: string, config: LLMConfig, messageService: MessageService, tools: LLMTool, fileStore?: IFileStore) {
        this.config = config;
        this.client = new OpenAI({ apiKey });
        this.messageService = messageService;
        this.tools = tools
        this.fileStore = fileStore;
    }

    supportsTools(): boolean {
        return true;
    }

    private fromInput(messages: LLMMessage[]): ResponseInputItem[] {
        return messages.map((m): ResponseInputItem => {
            switch (m.role) {
                case "user":
                    return {
                        type: "message",
                        role: "user",
                        content: (m.content as ContentPart[]).map((msg) => {
                            switch (msg.type) {
                                case "text":
                                    return {
                                        type: "input_text",
                                        text: (msg as TextContent).text
                                    } as ResponseInputText;

                                case "input_file":
                                    return {
                                        type: "input_file",
                                        file_url: (msg as FileInput).fileUrl
                                    } as ResponseInputFile;

                                case "input_base64_image":
                                    return {
                                        type: "input_image",
                                        image_url: `data:${(msg as ImageBase64Content).source.media_type};base64,${(msg as ImageBase64Content).source.data}`,
                                        detail: "auto"
                                    } as ResponseInputImage;

                                case "input_url_image":
                                    return {
                                        type: "input_image",
                                        image_url: (msg as ImageUrlContent).image_url.url,
                                        detail: "auto"
                                    } as ResponseInputImage;

                                default:
                                    throw new Error(
                                        `Unsupported content type: ${msg.type}`
                                    );
                            }
                        })
                    };

                case "assistant": {
                    // "code_interpreter" parts are UI-only (streamed code + generated
                    // files, kept so the frontend can replay history) — they aren't a
                    // valid Responses API input content type, so they must never be
                    // handed back to the model when a saved conversation is replayed.
                    const assistantParts = (m.content as ContentPart[]).filter((msg) => msg.type !== "code_interpreter");
                    const partsToSend = assistantParts.length ? assistantParts : [{ type: "output_text", text: "" } as TextContent];
                    return {
                        type: "message",
                        role: "assistant",
                        content: partsToSend.map((msg) => {
                            switch (msg.type) {
                                case "text":
                                case "output_text":
                                    return {
                                        type: "output_text",
                                        text: (msg as TextContent).text
                                    } as ResponseOutputText

                                default:
                                    throw new Error(
                                        `Unsupported assistant content type: ${msg.type}`
                                    );
                            }
                        })

                    } as ResponseInputItem;
                }

                case "tool_call":
                    return {
                        type: "function_call",
                        call_id: m.tool_call_id,
                        name: m.name,
                        arguments: JSON.stringify(m.arguments)
                    } as ResponseFunctionToolCall

                case "tool_call_output":
                    return {
                        type: "function_call_output",
                        call_id: m.tool_call_id,
                        output: typeof m.output === "string" ? m.output : JSON.stringify(m.output)

                    } as ResponseInputItem



                case "system":
                    return {
                        type: "message",
                        role: "system",
                        content: (m.content as ContentPart[]).map((msg) => {
                            switch (msg.type) {
                                case "input_text":
                                    return {
                                        type: "input_text",
                                        text: (msg as TextContent).text
                                    } as ResponseInputText;

                                default:
                                    throw new Error(
                                        `Unsupported system content type: ${msg.type}`
                                    );
                            }
                        })
                    };

                default:
                    return {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "[unreadable message]" }]
                    };
            }
        });

    }

    chat(messages: LLMMessage[], tools?: Tool[]): Promise<LLMResponse> {
        throw new Error("Method not implemented.");
    }

    async summarizeChat(message: ResponseInputItem[]): Promise<string> {
        const promptMessage: ResponseInputItem = {
            type: "message",
            role: "system",
            content: [
                {
                    type: "input_text",
                    text: `
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
                                `.trim(),
                },
            ],
        };

        const inputMessages = [promptMessage, ...message]
        try {
            const response = await this.client.responses.create({
                model: this.config.model,
                input: inputMessages,
                temperature: 0.3,
                max_output_tokens: 20,
            });
            console.log(response.output_text?.trim())
            return response.output_text?.trim() || "New Conversation";

        } catch (error) {
            console.error("Failed to generate title:", error);
            return "New Conversation";
        }

    }
    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string, apiKey: string,signal:AbortSignal): AsyncGenerator<LLMMessage, void, unknown> {
        await this.messageService.runTransaction(sessionId, messages);
        const userSessionMessages = await this.messageService.loadMessages(sessionId);
        const parseUserSessionMessages = this.fromInput(userSessionMessages);
        let inputMessages = [...parseUserSessionMessages];
        const mcpTools = this.getMcpServerConfigs().map((server) => ({
            type: "mcp",
            server_label: server.label,
            server_url: server.url,
            require_approval: server.requireApproval ?? "never",
            ...(server.allowedTools ? { allowed_tools: server.allowedTools } : {}),
        }));
        const functionTools = this.tools.getAll().map((def) => ({
            type: "function",
            name: def.name,
            description: def.description,
            parameters: def.parameters,
        }));

        // Code interpreter's container only sees files explicitly attached to
        // it via `file_ids` — the `input_file` parts built in fromInput() carry
        // only an S3 file_url, which the container can't read. storage_routes.ts
        // now additionally uploads spreadsheets (csv/xls/xlsx only — everything
        // else keeps going through the existing S3 + RAG path unchanged) to
        // OpenAI's Files API and stamps the resulting id onto that same
        // content part as `openaiFileId`. Re-derived from the full history
        // (not just the latest message) on every call since this provider
        // resends the whole conversation each turn with no server-side
        // container reuse — a spreadsheet uploaded three turns ago still
        // needs to be re-attached for the model to reference it now.
        const spreadsheetFileIds = Array.from(new Set(
            userSessionMessages.flatMap((m) => {
                if (m.role !== "user" || !Array.isArray(m.content)) return [];
                return (m.content as any[])
                    .filter((part) => part?.type === "input_file" && typeof part.openaiFileId === "string")
                    .map((part) => part.openaiFileId as string);
            })
        ));

        // Recomputed on every fetch attempt (not just once) because a
        // reused container can turn out to be stale — see the
        // "container looks invalid/expired" retry below, which flips
        // forceFreshContainer and re-enters the loop needing a fresh
        // `type: "auto"` + file_ids build instead of the reused id.
        let forceFreshContainer = false;
        const buildCodeInterpreterTools = () => {
            if (!this.enableCodeInterpreter) return [];
            const reusable = !forceFreshContainer ? this.findReusableContainer(userSessionMessages) : null;
            const canReuse = !!reusable && reusable.ageMs < this.CONTAINER_REUSE_WINDOW_MS;
            return [{
                type: "code_interpreter",
                container: canReuse
                    // Reusing the same container means the files it already has
                    // are still there — no need to resend file_ids at all.
                    ? reusable!.containerId
                    : {
                        type: "auto",
                        ...(this.codeInterpreterMemory ? { memory_limit: this.codeInterpreterMemory } : {}),
                        ...(spreadsheetFileIds.length ? { file_ids: spreadsheetFileIds } : {}),
                    },
            }];
        };

        const collectedSources = new Set<string>();
        const collectedCodeFiles: Array<{ file_id: string; container_id: string; filename?: string; url?: string }> = [];
        const collectedCodeFileKeys = new Set<string>();

        let continueLoop = true;
        while (continueLoop) {
            if (signal.aborted) break;
            const functionCallTools = new Map<string, any>();
            const mcpCallTools = new Map<string, any>();
            const codeInterpreterCalls = new Map<string, { id: string; container_id?: string; code: string; status: string }>();
            let calledAnyToolThisTurn = false;
            const wireTools = [...functionTools, ...mcpTools, ...buildCodeInterpreterTools()];
            try {
                const res = await fetch(this.baseUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                        model: this.config.model,
                        input: inputMessages,
                        max_output_tokens: this.config.maxTokens,
                        temperature: this.config.temperature,
                        tools: wireTools.length ? wireTools : undefined,
                        stream: true,
                    }),
                    signal,
                });

                if (!res.ok) {
                    let errBody: any = null;
                    try { errBody = await res.json(); } catch {  }
                    const message = errBody?.error?.message ?? `HTTP ${res.status}`;
                    console.error(`[OpenAIProvider] OpenAI responses API returned ${res.status}:`, JSON.stringify(errBody ?? message));
                    const reusedContainerLooksExpired =
                        !forceFreshContainer &&
                        (res.status === 400 || res.status === 404) &&
                        /container/i.test(message);
                    if (reusedContainerLooksExpired) {
                        console.warn(`[OpenAIProvider] reused code-interpreter container was rejected ("${message}") — retrying once with a fresh container.`);
                        forceFreshContainer = true;
                        continue;
                    }

                    if (res.status === 401) {
                        yield { type: "error", code: "auth", message: "Invalid API key.", content: [{ type: "auth", text: "Invalid API key." }] };
                    } else if (res.status === 429) {
                        yield { type: "error", code: "rate_limit", message: "Rate limit hit. Please wait and retry.", content: [{ type: "rate_limit", text: "Rate limit hit. Please wait and retry." }] };
                    } else if (res.status === 403) {
                        yield { type: "error", code: "permission", message: "Access denied.", content: [{ type: "permission", text: "Access denied." }] };
                    } else if (res.status >= 500) {
                        yield { type: "error", code: "server", message: "OpenAI server error. Try again shortly.", content: [{ type: "server", text: "OpenAI server error. Try again shortly." }] };
                    } else {
                        yield { type: "error", code: "error", message, content: [{ type: "error", text: message }] };
                    }
                    continueLoop = false;
                    break;
                }

                if (!res.body) {
                    yield { type: "error", code: "error", message: "No response body received.", content: [{ type: "error", text: "No response body received." }] };
                    continueLoop = false;
                    break;
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let buffer = "";
                let sawResponseCompleted = false;

                readLoop:
                while (true) {
                    if (signal.aborted) {
                        await reader.cancel();
                        continueLoop = false;
                        break;
                    }

                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });

                    let frameEnd: number;
                    while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
                        const rawFrame = buffer.slice(0, frameEnd);
                        buffer = buffer.slice(frameEnd + 2);

                        const dataLine = rawFrame.split("\n").find((line) => line.startsWith("data:"));
                        if (!dataLine) continue;

                        const jsonStr = dataLine.slice("data:".length).trim();
                        if (jsonStr === "[DONE]") continue;

                        let event: any;
                        try {
                            event = JSON.parse(jsonStr);
                        } catch {
                            continue;
                        }

                        if (event.type === "response.output_text.delta") {
                            yield {
                                type: "message",
                                role: "assistant",
                                content: [{ type: "text", text: event.delta }] as ContentPart[]
                            };
                        }

                        if (event.type === "response.output_text.done") {
                            try {
                                const codeInterpreterParts: ContentPart[] = [...codeInterpreterCalls.values()].map((call) => ({
                                    type: "code_interpreter",
                                    code: call.code,
                                    status: call.status,
                                    container_id: call.container_id,
                                    files: collectedCodeFiles.filter((f) => !call.container_id || f.container_id === call.container_id),
                                } as unknown as ContentPart));

                                const assistantMessage: LLMMessage = {
                                    type: "message",
                                    role: "assistant",
                                    content: [{ type: "output_text", text: event.text }, ...codeInterpreterParts],
                                    sources: collectedSources.size ? Array.from(collectedSources) : undefined,
                                };
                                await this.messageService.createLLMMessage(sessionId, assistantMessage);
                                inputMessages = [...inputMessages, ...this.fromInput([assistantMessage])];
                                if ([1, 2, 3, 4].includes(inputMessages.length)) {
                                    const titleToUpdate = await this.summarizeChat(inputMessages);
                                    await this.messageService.updateTitle(sessionId, userId, titleToUpdate);
                                    yield { type: "session_title", content: titleToUpdate };
                                }
                            } catch (err) {
                                const errMsg = err instanceof Error ? err.message : String(err);
                                yield { type: "error", code: "error", message: `Error in generating response: ${errMsg}`, error: "Error in generating response", isDone: true };
                            }
                        }

                        if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
                            functionCallTools.set(event.item.id ?? "", {
                                id: event.item.id,
                                name: event.item.name,
                                type: event.item.type,
                                tool_call_id: event.item.call_id,
                                arguments: "",
                            });
                            yield {
                                id: event.item.id,
                                name: event.item.name,
                                type: event.item.type,
                                tool_call_id: event.item.call_id,
                            } as LLMMessage;
                        }

                       
                        if (event.type === "response.output_item.added" && event.item?.type === "mcp_call") {
                            mcpCallTools.set(event.item.id ?? "", {
                                id: event.item.id,
                                name: event.item.name,
                                serverLabel: event.item.server_label,
                            });
                            yield {
                                type: "mcp_call",
                                tool_call_id: event.item.id,
                                name: event.item.name,
                                server_label: event.item.server_label,
                            } as unknown as LLMMessage;
                        }

                       
                        if (event.type === "response.output_item.added" && event.item?.type === "mcp_list_tools") {
                            yield {
                                type: "mcp_list_tools",
                                server_label: event.item.server_label,
                                tools: event.item.tools,
                            } as unknown as LLMMessage;
                        }

                        if (event.type === "response.output_item.added" && event.item?.type === "mcp_approval_request") {
                            yield {
                                type: "mcp_approval_request",
                                id: event.item.id,
                                name: event.item.name,
                                server_label: event.item.server_label,
                                arguments: event.item.arguments,
                            } as LLMMessage;

                        }

                        if (event.type === "response.output_item.added" && event.item?.type === "code_interpreter_call") {
                            codeInterpreterCalls.set(event.item.id ?? "", {
                                id: event.item.id,
                                container_id: event.item.container_id,
                                code: "",
                                status: "in_progress",
                            });
                            yield {
                                type: "code_interpreter_call",
                                tool_call_id: event.item.id,
                            } as unknown as LLMMessage;
                        }

                        if (event.type === "response.code_interpreter_call_code.delta") {
                            const call = codeInterpreterCalls.get(event.item_id);
                            if (call) {
                                call.code += event.delta ?? "";
                                yield {
                                    type: "code_interpreter_call_code_delta",
                                    tool_call_id: event.item_id,
                                    delta: event.delta,
                                } as unknown as LLMMessage;
                            }
                        }

                        if (event.type === "response.code_interpreter_call_code.done") {
                            const call = codeInterpreterCalls.get(event.item_id);
                            if (call) {
                                call.code = event.code ?? call.code;
                                yield {
                                    type: "code_interpreter_call_code_done",
                                    tool_call_id: event.item_id,
                                    code: call.code,
                                } as unknown as LLMMessage;
                            }
                        }

                        if (event.type === "response.code_interpreter_call.interpreting") {
                            const call = codeInterpreterCalls.get(event.item_id);
                            if (call) call.status = "interpreting";
                            yield {
                                type: "code_interpreter_call_status",
                                tool_call_id: event.item_id,
                                status: "interpreting",
                            } as unknown as LLMMessage;
                        }

                        if (event.type === "response.code_interpreter_call.completed") {
                            const call = codeInterpreterCalls.get(event.item_id);
                            if (call) call.status = "completed";
                            yield {
                                type: "code_interpreter_call_status",
                                tool_call_id: event.item_id,
                                status: "completed",
                            } as unknown as LLMMessage;
                        }

                        // The container_id isn't guaranteed to be present yet on the
                        // "added" event above — it's confirmed present here — so back-fill
                        // it defensively in case it was missing earlier.
                        if (event.type === "response.output_item.done" && event.item?.type === "code_interpreter_call") {
                            const call = codeInterpreterCalls.get(event.item.id);
                            if (call && !call.container_id && event.item.container_id) {
                                call.container_id = event.item.container_id;
                            }
                        }

                        if (event.type === "response.code_interpreter_call.failed") {
                            const call = codeInterpreterCalls.get(event.item_id);
                            if (call) call.status = "failed";
                            const ciErrMsg = `Code interpreter call failed: ${event.error?.message ?? event.response?.error?.message ?? "unknown"}`;
                            yield {
                                type: "code_interpreter_call_status",
                                tool_call_id: event.item_id,
                                status: "failed",
                                message: ciErrMsg,
                            } as unknown as LLMMessage;
                        }

                        // Generated file (chart, csv, etc.) cited on the assistant's output text.
                        if (event.type === "response.output_text.annotation.added" && event.annotation?.type === "container_file_citation") {
                            const fileKey = `${event.annotation.container_id}:${event.annotation.file_id}`;
                            if (!collectedCodeFileKeys.has(fileKey)) {
                                collectedCodeFileKeys.add(fileKey);
                                const fileRef: { file_id: string; container_id: string; filename?: string; url?: string } = {
                                    file_id: event.annotation.file_id as string,
                                    container_id: event.annotation.container_id as string,
                                    filename: event.annotation.filename as string | undefined,
                                };
                                collectedCodeFiles.push(fileRef);

                                // Mirror the file to S3 right now, while the container is
                                // still definitely alive — waiting until the user clicks
                                // "download" later means the container may already be
                                // gone. Awaited inline so fileRef.url is already set by
                                // the time response.output_text.done (below) builds the
                                // persisted code_interpreter content part; best-effort —
                                // on any failure this just leaves url unset and the old
                                // live-container-proxy route (session_routes.ts) is still
                                // there as a fallback.
                                const persisted = await this.persistCodeInterpreterFile(
                                    fileRef.container_id,
                                    fileRef.file_id,
                                    fileRef.filename,
                                    userId,
                                    apiKey
                                );
                                if (persisted) fileRef.url = persisted.url;

                                yield {
                                    type: "code_interpreter_file",
                                    file_id: fileRef.file_id,
                                    container_id: fileRef.container_id,
                                    filename: fileRef.filename,
                                    url: fileRef.url,
                                } as unknown as LLMMessage;
                            }
                        }

                        if (event.type === "response.function_call_arguments.done") {
                            const item = functionCallTools.get(event.item_id);
                            if (item) {
                                item.arguments = event.arguments;
                                yield {
                                    type: "function_call_arguments",
                                    tool_call_id: item.tool_call_id,
                                    arguments: item.arguments,
                                } as LLMMessage;

                                let result: string;
                                // Hoisted out of the try so it's still in scope when
                                // constructing `toolCall` below; also fixes a double-JSON-encoding
                                // bug: fromInput()'s "tool_call" case does JSON.stringify(m.arguments),
                                // which assumes arguments is an object. Storing the raw string here
                                // meant every replay re-stringified an already-stringified value.
                                let parsedArgs: Record<string, any> = {};
                                try {
                                    const db = await this.messageService.rawDb() as unknown as IDatabaseAdapter;
                                    try {
                                        parsedArgs = item.arguments ? JSON.parse(item.arguments) : {};
                                    } catch {
                                        throw new Error(`Model produced invalid JSON arguments for "${item.name}": ${item.arguments}`);
                                    }

                                    const toolOutput = await this.tools.executeTool(item.name, parsedArgs, { db });
                                    result = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);
                                    yield {
                                        type: "function_call_output",
                                        tool_call_id: item.tool_call_id,
                                        output: result,
                                    } as LLMMessage;

                                    // RAG source extraction. search_knowledge_base
                                    // (createVectorSearchTool in the RAG tool file) returns
                                    // a single result object shaped like:
                                    //   { source_file, heading, score, content }
                                    // — NOT wrapped in a `results` array. It may also come
                                    // back as an array of these objects when there are
                                    // multiple matches. Normalize both shapes into an array
                                    // before pulling out source_file, dedupe, and push a live
                                    // update to the client immediately, in addition to
                                    // attaching them to the final assistant message later.
                                    try {
                                        if (item.name === this.RAG_TOOL_NAME) {
                                            const parsedOutput = typeof toolOutput === "string" ? JSON.parse(toolOutput) : toolOutput;
                                            const resultsArray = Array.isArray(parsedOutput)
                                                ? parsedOutput
                                                : parsedOutput
                                                    ? [parsedOutput]
                                                    : [];

                                            const filenames: string[] = resultsArray
                                                .map((r: any) => r?.source_file)
                                                .filter((f: unknown): f is string => typeof f === "string" && f.length > 0);

                                            if (filenames.length) {
                                                filenames.forEach((f) => collectedSources.add(f));
                                                yield {
                                                    type: "sources",
                                                    tool_call_id: item.tool_call_id,
                                                    sources: Array.from(collectedSources),
                                                } as unknown as LLMMessage;
                                            }
                                        }
                                    } catch {
                                       
                                    }
                                } catch (toolErr) {
                                    const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                                    result = JSON.stringify({
                                        error: true,
                                        message: errMsg,
                                        hint: "Tool execution failed. Do not retry with the same arguments."
                                    });
                                    yield {
                                        type: "function_call_output",
                                        tool_call_id: item.tool_call_id,
                                        error: result,
                                    } as LLMMessage;
                                }

                                const toolCall: LLMMessage = { role: "tool_call", type: "tool_call", tool_call_id: item.tool_call_id, name: item.name, arguments: parsedArgs };
                                const toolResult: LLMMessage = { role: "tool_call_output", type: "tool_call_output", tool_call_id: item.tool_call_id, output: result };

                                try {
                                    await this.messageService.runTransaction(sessionId, [toolCall, toolResult]);
                                } catch (dbErr) {
                                    const dbErrMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
                                    yield { type: "error", code: "error", message: `Something went wrong while saving the tool result: ${dbErrMsg}`, error: "Something went wrong while saving the tool result. Please try again." } as LLMMessage;
                                    continueLoop = false;
                                }

                                inputMessages = [...inputMessages, ...this.fromInput([toolCall, toolResult])];
                                functionCallTools.delete(event.item_id);
                                calledAnyToolThisTurn = true; // a real tool ran; the model still needs a follow-up request to see its output
                            }
                        }


                        if (event.type === "response.mcp_call_arguments.done") {
                            const item = mcpCallTools.get(event.item_id);
                            if (item) {
                                yield {
                                    type: "mcp_call_arguments",
                                    tool_call_id: item.id,
                                    name: item.name,
                                    args: event.arguments,
                                } as unknown as LLMMessage;
                            }
                        }

                        if (event.type === "response.mcp_call.completed") {
                            const item = mcpCallTools.get(event.item_id);
                            yield {
                                type: "mcp_call_output",
                                tool_call_id: item?.id,
                                output: event.output,
                            } as unknown as LLMMessage;
                            if (item) mcpCallTools.delete(event.item_id);
                        }

                        if (event.type === "response.mcp_call.failed") {
                            const mcpErrMsg = `MCP call failed: ${event.error?.message ?? "unknown"}`;
                            yield {
                                type: "error",
                                code: "error",
                                message: mcpErrMsg,
                                error: mcpErrMsg,
                            } as unknown as LLMMessage;
                            mcpCallTools.delete(event.item_id);
                        }

                        if (event.type === "response.completed") {
                            sawResponseCompleted = true;
                            if (!functionCallTools.size && !mcpCallTools.size) {
                                if (calledAnyToolThisTurn) {
                                    break readLoop;
                                }
                                yield {
                                    content: "",
                                    isDone: true,
                                    sources: collectedSources.size ? Array.from(collectedSources) : undefined,
                                };
                                continueLoop = false;
                                break readLoop;
                            }
                        }

                        if (event.type === "response.failed") {
                            throw new Error(`OpenAI response failed: ${event.response?.error?.message ?? "unknown"}`);
                        }
                    }
                }

                if (continueLoop && !sawResponseCompleted) {
                    yield { type: "error", code: "error", message: "Stream ended unexpectedly.", content: [{ type: "error", text: "Stream ended unexpectedly." }] };
                    continueLoop = false;
                }

            } catch (err: any) {
                if (err?.name === "AbortError") {
                    yield { type: "cancelled", content: [{ type: "aborted", text: "Request cancelled." }] };
                } else {
                    console.error("[OpenAIProvider] chatStream request threw:", err);
                    const errMsg = err?.message ?? "unexpected";
                    yield { type: "error", code: "error", message: errMsg, content: [{ type: "error", text: errMsg }] };
                    continueLoop = false;
                }
                continueLoop = false;
            }
        }
    }
    private findReusableContainer(messages: LLMMessage[]): { containerId: string; ageMs: number } | null {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role !== "assistant" || !Array.isArray(m.content)) continue;

            const ciPart = (m.content as any[])
                .slice()
                .reverse()
                .find((p) => p?.type === "code_interpreter" && typeof p.container_id === "string");
            if (!ciPart) continue;

            const createdAtMs = m.createdAt ? new Date(m.createdAt).getTime() : NaN;
            if (Number.isNaN(createdAtMs)) return null;

            return { containerId: ciPart.container_id, ageMs: Date.now() - createdAtMs };
        }
        return null;
    }
    private async persistCodeInterpreterFile(
        containerId: string,
        fileId: string,
        filename: string | undefined,
        userId: string,
        apiKey: string
    ): Promise<{ url: string; key: string } | undefined> {
        if (!this.fileStore) return undefined;
        try {
            const contentRes = await fetch(
                `https://api.openai.com/v1/containers/${containerId}/files/${fileId}/content`,
                { headers: { Authorization: `Bearer ${apiKey}` } }
            );
            if (!contentRes.ok) {
                console.warn(`[OpenAIProvider] could not fetch code interpreter file ${fileId} to persist (status ${contentRes.status})`);
                return undefined;
            }

            const buffer = Buffer.from(await contentRes.arrayBuffer());
            const mimetype = contentRes.headers.get("content-type") ?? "application/octet-stream";
            const safeName = (filename ?? fileId).split("/").pop() || fileId;

            const [uploaded] = await this.fileStore.uploadAndGetUrls(
                [{ buffer, originalname: `${fileId}_${safeName}`, mimetype }],
                `${userId}/code-interpreter-files/`,
                { expiresInSeconds: this.CODE_INTERPRETER_FILE_URL_TTL_SECONDS }
            );
            return uploaded ? { url: uploaded.url, key: uploaded.key } : undefined;
        } catch (error) {
            console.error(`[OpenAIProvider] failed to persist code interpreter file ${fileId}:`, error);
            return undefined;
        }
    }

    private getMcpServerConfigs(): Array<{ label: string; url: string; requireApproval?: string; allowedTools?: string[] }> {
        if (!this.enableDeepwikiMcp) return [];
        return [
            {
                label: "deepwiki",
                url: "https://mcp.deepwiki.com/mcp",
                requireApproval: "never",
            },
        ];
    }

    getProvider(): string {
        return "openai";
    }

    getModel(): string {
        return this.config.model;
    }
}