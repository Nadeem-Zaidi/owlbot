import OpenAI from "openai";
import type { ResponseFunctionToolCall, ResponseInputFile, ResponseInputImage, ResponseInputItem, ResponseInputText, ResponseOutputText } from "openai/resources/responses/responses";
import { ILLM } from "../interfaces/illm";
import { ContentPart, FileInput, ImageBase64Content, ImageUrlContent, LLMMessage, TextContent, Tool, ToolCall } from "../types/llm_message";
import { LLMResponse } from "../types/llm_response";
import { LLMConfig } from "../types/lmconfig";
import { LLMTool } from "../tools/tool_registry";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { MessageService } from "../service/message_service";



export class OpenAIProvider implements ILLM {
    private client: OpenAI;
    private config: LLMConfig;
    private messageService: MessageService;
    private abortController: AbortController | null = null;
    private readonly baseUrl = "https://api.openai.com/v1/responses";
    private tools:LLMTool



    constructor(apiKey: string, config: LLMConfig, messageService: MessageService,tools:LLMTool) {
        this.config = config;
        this.client = new OpenAI({ apiKey });
        this.messageService = messageService;
        this.tools=tools
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
                                        file_id: (msg as FileInput).file_id
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

                case "assistant":
                    return {
                        type: "message",
                        role: "assistant",
                        content: (m.content as ContentPart[]).map((msg) => {
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
                        output: m.output

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
                    // sanitizer should have caught this — but just in case
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
    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string, apiKey: string): AsyncGenerator<LLMMessage, void, unknown> {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
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

        const tools = [...mcpTools];

        let continueLoop = true;
        while (continueLoop) {
            if (signal.aborted) break;
            const functionCallTools = new Map<string, any>();
            const mcpCallTools = new Map<string, any>();

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
                        tools: tools.length ? tools : undefined,
                        stream: true,
                    }),
                    signal,
                });

                if (!res.ok) {
                    let errBody: any = null;
                    try { errBody = await res.json(); } catch { /* not JSON */ }
                    const message = errBody?.error?.message ?? `HTTP ${res.status}`;

                    if (res.status === 401) {
                        yield { type: "error", content: [{ type: "auth", text: "Invalid API key." }] };
                    } else if (res.status === 429) {
                        yield { type: "error", content: [{ type: "rate_limit", text: "Rate limit hit. Please wait and retry." }] };
                    } else if (res.status === 403) {
                        yield { type: "error", content: [{ type: "permission", text: "Access denied." }] };
                    } else if (res.status >= 500) {
                        yield { type: "error", content: [{ type: "server", text: "OpenAI server error. Try again shortly." }] };
                    } else {
                        yield { type: "error", content: [{ type: "error", text: message }] };
                    }
                    continueLoop = false;
                    break;
                }

                if (!res.body) {
                    yield { type: "error", content: [{ type: "error", text: "No response body received." }] };
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
                                const assistantMessage: LLMMessage = { type: "message", role: "assistant", content: [{ type: "output_text", text: event.text }] };
                                await this.messageService.createLLMMessage(sessionId, assistantMessage);
                                inputMessages = [...inputMessages, ...this.fromInput([assistantMessage])];
                                if ([1, 2, 3, 4].includes(inputMessages.length)) {
                                    const titleToUpdate = await this.summarizeChat(inputMessages);
                                    await this.messageService.updateTitle(sessionId, userId, titleToUpdate);
                                    yield { type: "session_title", content: titleToUpdate };
                                }
                            } catch (err) {
                                yield { type: "error", error: "Error in generating response", isDone: true };
                            }
                        }

                        // ── local function_call (unchanged) ──
                        if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
                            functionCallTools.set(event.item.id ?? "", {
                                id: event.item.id,
                                name: event.item.name,
                                type: event.item.type,
                                call_id: event.item.call_id,
                                arguments: "",
                            });
                            yield {
                                id: event.item.id,
                                name: event.item.name,
                                type: event.item.type,
                                tool_call_id: event.item.call_id,
                            } as LLMMessage;
                        }

                        // ── remote mcp_call started — OpenAI's backend will execute this itself ──
                        if (event.type === "response.output_item.added" && event.item?.type === "mcp_call") {
                            mcpCallTools.set(event.item.id ?? "", {
                                id: event.item.id,
                                name: event.item.name,
                                serverLabel: event.item.server_label,
                            });
                            yield {
                                type: "mcp_call",
                                tool_call_id: event.item.id,   // renamed from "id"
                                name: event.item.name,
                                server_label: event.item.server_label,
                            } as unknown as LLMMessage;
                        }

                        // ── MCP server exposed its tool list — informational only ──
                        if (event.type === "response.output_item.added" && event.item?.type === "mcp_list_tools") {
                            yield {
                                type: "mcp_list_tools",
                                server_label: event.item.server_label,
                                tools: event.item.tools,
                            } as unknown as LLMMessage;
                        }

                        // ── requires human approval before OpenAI calls the MCP tool ──
                        if (event.type === "response.output_item.added" && event.item?.type === "mcp_approval_request") {
                            yield {
                                type: "mcp_approval_request",
                                id: event.item.id,
                                name: event.item.name,
                                server_label: event.item.server_label,
                                arguments: event.item.arguments,
                            } as LLMMessage;
                           
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

                                let result = "";
                                try {
                                    const db = await this.messageService.rawDb() as unknown as IDatabaseAdapter;
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

                                const toolCall: LLMMessage = { role: "tool_call", type: "tool_call", tool_call_id: item.tool_call_id, name: item.name, arguments: item.arguments };
                                const toolResult: LLMMessage = { role: "tool_call_output", type: "tool_call_output", tool_call_id: item.tool_call_id, output: result };

                                try {
                                    await this.messageService.runTransaction(sessionId, [toolCall, toolResult]);
                                } catch (dbErr) {
                                    yield { type: "error", error: "Something went wrong while saving the tool result. Please try again." } as LLMMessage;
                                    continueLoop = false;
                                }

                                inputMessages = [...inputMessages, ...this.fromInput([toolCall, toolResult])];
                                functionCallTools.delete(event.item_id);
                            }
                        }

                       
                        if (event.type === "response.mcp_call_arguments.done") {
                            const item = mcpCallTools.get(event.item_id);
                            if (item) {
                                yield {
                                    type: "mcp_call_arguments",
                                    tool_call_id: item.id,
                                    name: item.name,
                                    args: event.arguments,   // renamed from "arguments" to match frontend
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
                            yield {
                                type: "error",
                                error: `MCP call failed: ${event.error?.message ?? "unknown"}`,
                            } as unknown as LLMMessage;
                            mcpCallTools.delete(event.item_id);
                        }

                        if (event.type === "response.completed") {
                            sawResponseCompleted = true;
                            if (!functionCallTools.size && !mcpCallTools.size) {
                                yield { content: "", isDone: true };
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
                    yield { type: "error", content: [{ type: "error", text: "Stream ended unexpectedly." }] };
                    continueLoop = false;
                }

            } catch (err: any) {
                if (err?.name === "AbortError") {
                    yield { type: "cancelled", content: [{ type: "aborted", text: "Request cancelled." }] };
                } else {
                    yield { type: "error", content: [{ type: "error", text: err?.message ?? "unexpected" }] };
                    continueLoop = false;
                    throw err;
                }
                continueLoop = false;
            }
        }
    }

    private getMcpServerConfigs(): Array<{ label: string; url: string; requireApproval?: string; allowedTools?: string[] }> {
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