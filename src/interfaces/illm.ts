import { LLMMessage, Tool, ToolCall } from "../types/llm_message";
import { LLMResponse } from "../types/llm_response";
import { ToolContext, ToolDefinition } from "../types/type";

// Anything that can list tools and run them (the global LLMTool registry, or
// an agent's own tool set).
export interface ToolSource {
    getAll(): ToolDefinition[];
    executeTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<any>;
}

// Per-request overrides used when chatting with an agent.
export type ChatRunOptions = {
    systemPrompt?: string;     // prepended to the conversation's system instructions
    tools?: ToolSource;        // replaces the default tool registry
    codeInterpreter?: boolean; // OpenAI hosted code interpreter (default: env setting)
};


export type StreamChunk = {
    type:string;
    content: string;
    isToolCall: boolean;
    toolCalls?: Record<string, any>;
    isDone: boolean;
}


export interface ILLM{
    chat(messages:LLMMessage[],tools:Tool[]):Promise<LLMResponse>;
    // `model` overrides the provider's default for this request; it must be one of getModels().
    // `run` carries an agent's instructions and tools; omit it for a normal chat.
    chatStream(messages:LLMMessage[],userId:string,sessionId:string,apiKey:string,signal:AbortSignal,model?:string,run?:ChatRunOptions):AsyncGenerator<LLMMessage,unknown,void>
    summarizeChat(message:any,userId:string,sessionId:string):Promise<string>
    getProvider():string;
    getModel():string;
    // Models selectable for this provider; callers fall back to [getModel()] when absent.
    getModels?():string[];
    supportsTools(): boolean;
}