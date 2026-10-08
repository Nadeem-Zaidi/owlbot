import { LLMMessage } from "../../types/llm_message";

// Plain-text rendering of stored messages, as input for the summarizer.
// Long parts are shortened: a summary needs what was said and decided, not
// every line of a pasted document or tool output.
const MAX_TEXT_CHARS = 2_000;
const MAX_TOOL_CHARS = 400;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}… [${s.length - max} more characters]` : s);

function partText(part: any): string | null {
    if (!part || typeof part !== "object") return null;
    switch (part.type) {
        case "text":
        case "input_text":
        case "output_text":
            if (part.documentName) return `[attached document "${part.documentName}": ${clip(String(part.text ?? ""), 600)}]`;
            if (part.hidden) return null; // internal notes for the model, not conversation
            return clip(String(part.text ?? ""), MAX_TEXT_CHARS);
        case "input_file":
            return `[file: ${part.fileName ?? part.filename ?? "attachment"}]`;
        case "input_base64_image":
        case "input_url_image":
            return "[image]";
        case "code_interpreter":
            return "[ran code]";
        default:
            return null;
    }
}

export function renderTranscript(messages: LLMMessage[]): string {
    const lines: string[] = [];
    for (const m of messages) {
        if (m.role === "user" || m.role === "assistant") {
            const text = Array.isArray(m.content)
                ? (m.content as any[]).map(partText).filter(Boolean).join("\n")
                : typeof m.content === "string" ? clip(m.content, MAX_TEXT_CHARS) : "";
            if (text.trim()) lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${text.trim()}`);
        } else if (m.role === "tool_call") {
            const args = typeof m.arguments === "string" ? m.arguments : JSON.stringify(m.arguments ?? {});
            lines.push(`[Assistant used tool ${m.name ?? "tool"}(${clip(args, MAX_TOOL_CHARS)})]`);
        } else if (m.role === "tool_call_output") {
            const out = typeof m.output === "string" ? m.output : JSON.stringify(m.output ?? "");
            lines.push(`[Tool result: ${clip(out, MAX_TOOL_CHARS)}]`);
        }
    }
    return lines.join("\n\n");
}
