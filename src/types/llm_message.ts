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
    fileUrl?: string,
    // Set only for spreadsheet uploads (csv/xls/xlsx) — see storage_routes.ts's
    // uploadAndIndex(). Lets openai_provider.ts attach the file to the code
    // interpreter container's file_ids so it can actually read the data,
    // instead of the container having no access to uploaded files at all.
    openaiFileId?: string
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

export type CodeInterpreterFileRef = {
    file_id: string;
    container_id: string;
    filename?: string;
    // Permanent-ish S3 copy made the moment the file was generated — see
    // persistCodeInterpreterFile() in openai_provider.ts. OpenAI's own
    // container.file_id link dies with the container (~20 min idle); this
    // survives that so chat history stays viewable. Still a signed URL
    // (long-lived, but not literally forever) — absent for older messages
    // saved before this existed, which fall back to the live container
    // proxy route and will 404 once that container has expired.
    url?: string;
};

export type CodeInterpreterContent = {
    type: string; // "code_interpreter"
    code: string;
    status: string;
    files?: CodeInterpreterFileRef[];
    // Which OpenAI container actually ran this code. Persisted so a later
    // turn in the same chat can reuse this exact container instead of
    // spinning up (and re-attaching files to) a brand new one every time —
    // see findReusableContainer() in openai_provider.ts.
    container_id?: string;
};

export type ContentPart = TextContent | ImageUrlContent | ImageBase64Content | ImageId | FileInput | ToolCall | CodeInterpreterContent;

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
    // Only populated when a message is loaded back from the DB (see
    // message_repository.ts's sanitizeRow) — never sent to the model. Used
    // to judge whether a previously-used code interpreter container is
    // still fresh enough to reuse instead of creating a new one.
    createdAt?: string;
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