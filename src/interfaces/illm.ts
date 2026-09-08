import { LLMMessage, Tool, ToolCall } from "../types/llm_message";
import { LLMResponse } from "../types/llm_response";


export type StreamChunk = {
    type:string;
    content: string;
    isToolCall: boolean;
    toolCalls?: Record<string, any>;
    isDone: boolean;
}


export interface ILLM{
    chat(messages:LLMMessage[],tools:Tool[]):Promise<LLMResponse>;
    chatStream(messages:LLMMessage[],userId:string,sessionId:string,apiKey:string):AsyncGenerator<LLMMessage,unknown,void>
    summarizeChat(message:any,userId:string,sessionId:string):Promise<string>
    getProvider():string;
    getModel():string;
    supportsTools(): boolean;
}