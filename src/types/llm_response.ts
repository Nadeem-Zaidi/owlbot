import { ToolCall } from "openai/resources/beta/threads/runs.js";

export type LLMResponse={
    content:string|null;
    toolCalls?:ToolCall[]|undefined;
    finishReason:'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
}