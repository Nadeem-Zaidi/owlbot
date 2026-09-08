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


    constructor(apiKey: string, config: LLMConfig, messageService: MessageService) {
        this.config = config;
        this.client = new OpenAI({ apiKey });
        this.messageService = messageService;
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
    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string): AsyncGenerator<LLMMessage, void, unknown> {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        await this.messageService.runTransaction(sessionId, messages);
        const userSessionMessages = await this.messageService.loadMessages(sessionId);
        const parseUserSessionMessages = this.fromInput(userSessionMessages);
        let inputMessages = [...parseUserSessionMessages];

        let continueLoop = true;
        while (continueLoop) {
            if (signal.aborted) break;
            const functionCallTools = new Map<string, any>()
            try {
                const stream = this.client.responses.stream({
                    model: this.config.model ,
                    input: inputMessages,
                    max_output_tokens: this.config.maxTokens,
                    temperature: this.config.temperature,
                    stream: true,
                });

                for await (const event of stream) {
                    if (signal.aborted) {
                        stream.abort();
                        continueLoop = false;
                        break;
                    }
                    if (event.type === "response.output_text.delta") {
                        yield {
                            type: "message",
                            role: "assistant",
                            content: [
                                { type: "text", text: event.delta }
                            ] as ContentPart[]
                        }
                    }
                    if (event.type === "response.output_text.done") {
                        try {
                            const assistantMessage: LLMMessage = { type: "message", role: "assistant", content: [{ type: "output_text", text: event.text }] };
                            await this.messageService.createLLMMessage(sessionId, assistantMessage);
                            inputMessages = [...inputMessages, ...this.fromInput([assistantMessage])]
                            console.log(inputMessages.length)
                            if ([1, 2, 3, 4].includes(inputMessages.length)) {
                                const titleToUpdate = await this.summarizeChat(inputMessages);
                                console.log(titleToUpdate)
                                await this.messageService.updateTitle(sessionId, userId, titleToUpdate)

                                yield {
                                    type: "session_title",
                                    content: titleToUpdate

                                }
                            }

                        } catch (err) {
                            yield {
                                type: "error",
                                error: "Error in generating response",
                                isDone: true
                            }
                        }
                    }
                    if (event.type === "response.output_item.added") {
                        if (event.item.type === "function_call") {
                            functionCallTools.set(event.item.id ?? "", {
                                id: event.item.id,
                                name: event.item.name,
                                type: event.item.type,
                                call_id: event.item.call_id,
                                arguments: ''
                            });
                            yield {
                                id: event.item.id,
                                name: event.item.name,
                                type: event.item.type,
                                tool_call_id: event.item.call_id
                            } as LLMMessage
                        }
                    }

                    if (event.type === "response.function_call_arguments.done") {
                        const item = functionCallTools.get(event.item_id);
                        if (item) {
                            item.arguments = event.arguments;
                            yield {
                                type: "function_call_arguments",
                                tool_call_id: item.tool_call_id,
                                arguments: item.arguments // FIX: was item.argumnets (typo)
                            } as LLMMessage

                            const args = JSON.parse(item.arguments);
                            let result: string = "";
                            try {

                                const db = await this.messageService.rawDb() as unknown as IDatabaseAdapter;
                                // const rawResult = await this.toolRegistry.executeTool(item.name, args, { db });
                                // result = JSON.stringify(rawResult);

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
                                } as LLMMessage
                            }

                            const toolCall: LLMMessage = { role: "tool_call", type: "tool_call", tool_call_id: item.tool_call_id, name: item.name, arguments: item.arguments }
                            // FIX: output should be the tool's result, not the input arguments
                            const toolResult: LLMMessage = { role: "tool_call_output", type: "tool_call_output", tool_call_id: item.tool_call_id, output: result }

                            try {
                                await this.messageService.runTransaction(sessionId, [toolCall, toolResult]);

                            } catch (dbErr) {
                                yield {
                                    type: "error",
                                    error: "Something went wrong while saving the tool result. Please try again."
                                } as LLMMessage
                                continueLoop = false;
                            }

                            inputMessages = [...inputMessages, ...this.fromInput([toolCall, toolResult])];
                            functionCallTools.delete(event.item_id);
                        }
                    }

                    if (event.type === "response.completed") {
                        if (!functionCallTools.size) {
                            yield { content: "", isDone: true }
                            continueLoop = false
                        }

                    }

                    if (event.type === "response.failed") {
                        throw new Error(`OpenAI response failed: ${(event as any).response?.error?.message ?? "unknown"}`)
                    }
                }

            } catch (err) {
                if (err instanceof OpenAI.RateLimitError) {
                    // 429 — back off and retry
                    yield { type: "error", content: [{ type: "rate_limit", text: "Rate limit hit. Please wait and retry." }] };

                } else if (err instanceof OpenAI.AuthenticationError) {
                    // 401 — bad API key, no point retrying
                    yield { type: "error", content: [{ type: "auth", text: "Invalid API key." }] };

                } else if (err instanceof OpenAI.PermissionDeniedError) {
                    // 403
                    yield { type: "error", content: [{ type: "permission", text: "Access denied." }] };

                } else if (err instanceof OpenAI.InternalServerError) {
                    // 500-599 — OpenAI side, safe to retry
                    yield { type: "error", content: [{ type: "server", text: "OpenAI server error. Try again shortly." }] };

                } else if (err instanceof OpenAI.APIConnectionTimeoutError) {
                    // Request timed out — subclass of APIConnectionError, check first
                    yield { type: "error", content: [{ type: "timeout", text: "Request timed out." }] };

                } else if (err instanceof OpenAI.APIConnectionError) {
                    // Generic network failure (DNS, TCP reset, proxy, SSL)
                    yield { type: "error", content: [{ type: "network", text: "Could not reach OpenAI. Check your connection." }] };

                } else if (err instanceof OpenAI.APIError) {
                    // Catch-all for any other 4xx/5xx not covered above
                    yield { type: "error", content: [{ type: "error", text: err.message }] };

                } else {
                    // Unexpected — tell the renderer something went wrong,
                    // then rethrow so it also gets logged at the IPC level
                    yield {
                        type: "error",
                        content: [{ type: "error", text: "unexpected" }],
                    };
                    continueLoop = false;
                    throw err;  // ← still rethrow so main.ts logger catches it
                }

                continueLoop = false;
            }

        }
    }

    getProvider(): string {
        return "openai";
    }

    getModel(): string {
        return this.config.model;
    }
}