import { StreamChunk } from "../interfaces/illm";


export type TextContent = {
    type: string;
    text: string;
};

export type ToolCall = {
    type: string,
    id: string,
    name: string,
    arguments: Record<string, any>
}

export type ImageUrlContent = {
    type: string;
    image_url: {
        url: string;
        detail?: 'low' | 'high' | 'auto';
    };
};

export type ImageId = {
    type: string,
    file_id: string

}

export type FileInput = {
    type: string,
    file_id: string,
    fileName?: string,
    fileExtension?: string,
    fileUrl?: string
}

export type Tool = {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>
    }

}

export type ImageBase64Content = {
    type: string;
    source: {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
    };
};

export type ContentPart = TextContent | ImageUrlContent | ImageBase64Content | ImageId | ToolCall;

export type LLMConfig = {
    model: string;
    apiKey?: string;
    baseURL?: string;
    temperature?: number;
    maxTokens?: number;
}

export type LLMMessageToolCall = {
    type: string;
    id: string;
    name: string;
    call_id: string;
    arguments: Record<string, any>
    output: any
}


export interface LLMMessage {
    id?: string,
    role?: 'system' | 'user' | 'assistant' | 'tool' | 'tool_call' | 'tool_call_output';
    content?: string | ContentPart[]; // ContentPart — whatever you already import this from
    name?: string;
    arguments?: Record<string, any>;
    tool_call_id?: string;
    output?: any;
    type?: string;
    isDone?: boolean;
    error?: string;
    code?: string;    
    message?: string; 
    sources?: string[]; 
}


export type LLMResponse = {
    content: string | null;
    toolCalls?: ToolCall[] | undefined;
    finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
}

export interface ILLM {
    chatStream(messages: LLMMessage[], tools?: Tool[]): AsyncGenerator<StreamChunk, unknown, void>
    getProvider(): string;
    getModel(): string;
    supportsTools(): boolean
    fileUPload(fileName: string): Promise<string>
    abort(): void;
}