import { LLMMessage } from "./llm_message";
import { LLMResponse } from "./llm_response";
import { Tool, ToolCall } from "./tool";

export interface StreamChunk {
    content: string;
    isToolCall: boolean;
    toolCalls?: ToolCall[];
    isDone: boolean;
}

export interface ILLM {
    chat(
        messages: LLMMessage[],
        tools?: Tool[]
    ): Promise<LLMResponse>;

    /**
     * Send a streaming chat completion request
     */
    streamChat(
        messages: LLMMessage[],
        tools?: Tool[]
    ): AsyncGenerator<StreamChunk, void, unknown>;

    /**
     * Generate embeddings for text
     */
    generateEmbedding?(text: string): Promise<number[]>;

    /**
     * Get provider name
     */
    getProvider(): string;

    /**
     * Get model name
     */
    getModel(): string;
}