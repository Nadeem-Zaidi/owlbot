import { ToolCall } from "./tool";


type TextContent = {
    type: 'text';
    text: string;
};

// OpenAI format
type ImageUrlContent = {
    type: 'image_url';
    image_url: {
        url: string;  // "data:image/jpeg;base64,/9j/4AAQ..."
        detail?: 'low' | 'high' | 'auto';
    };
};

// Anthropic native format
type ImageBase64Content = {
    type: 'image';
    source: {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;  // raw base64 string without the data URI prefix
    };
};

type ContentPart = TextContent | ImageUrlContent | ImageBase64Content;


export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string |ContentPart[];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}
