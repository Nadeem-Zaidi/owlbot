import { LLMMessage } from "../../types/llm_message";

// Rough token counts (~4 characters per token). Good enough for budgeting:
// it only decides how much history to send, never what the user is billed
// (billing uses the provider's reported usage).
const CHARS_PER_TOKEN = 4;
// An image costs about this much whatever its base64 size.
const IMAGE_TOKENS = 1_500;

export function estimateTokens(m: LLMMessage): number {
    let chars = 0;
    let images = 0;
    if (Array.isArray(m.content)) {
        for (const part of m.content as any[]) {
            if (part?.type === "input_base64_image" || part?.type === "input_url_image") images++;
            else chars += JSON.stringify(part ?? "").length;
        }
    } else if (typeof m.content === "string") {
        chars += m.content.length;
    }
    const args: unknown = m.arguments;
    const out: unknown = m.output;
    chars += typeof args === "string" ? args.length : JSON.stringify(args ?? "").length;
    chars += typeof out === "string" ? out.length : JSON.stringify(out ?? "").length;
    return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS + 4; // + per-message overhead
}

export function sumTokens(messages: LLMMessage[]): number {
    return messages.reduce((n, m) => n + estimateTokens(m), 0);
}
