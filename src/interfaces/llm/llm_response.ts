import { ToolCall } from "./tool";

export interface LLMResponse {
    content: string | null;
    toolCalls: ToolCall[] | null;
    finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
}