import { ResponseFunctionToolCall, ResponseInputFile, ResponseInputImage, ResponseInputItem, ResponseInputText, ResponseOutputText } from "openai/resources/responses/responses.js";
import { ContentPart, FileInput, ImageBase64Content, ImageUrlContent, LLMMessage, TextContent } from "../types/llm_message";


async function fromLLM(llmMessages: Array<Record<string, any>>) {
        return llmMessages.map((m): ResponseInputItem => {
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
                    return {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "[unreadable message]" }]
                    };
            }
        });
    }