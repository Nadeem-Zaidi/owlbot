import { LLMMessage } from "../types/llm_message";

// How much stored history is sent to the model on each request. The whole
// conversation stays in the database; only the request is trimmed, so long
// chats don't grow slower and costlier every turn or overflow the context.
const MAX_MESSAGES = Number(process.env.LLM_HISTORY_MAX_MESSAGES ?? 60);
// ~4 characters per token, so the default is roughly 100k tokens.
const MAX_CHARS = Number(process.env.LLM_HISTORY_MAX_CHARS ?? 400_000);

function sizeOf(m: LLMMessage): number {
    return JSON.stringify([m.content ?? "", m.arguments ?? "", m.output ?? ""]).length;
}

/**
 * Keeps the newest messages that fit in the budget. The current turn (from
 * the last user message on) is always kept, even if it alone is over budget.
 * The window always starts at a user message, so it never opens with an
 * assistant reply or a tool result whose tool call was cut off. System
 * messages are always kept.
 */
export function windowHistory(
    messages: LLMMessage[],
    maxMessages: number = MAX_MESSAGES,
    maxChars: number = MAX_CHARS,
): LLMMessage[] {
    const system = messages.filter((m) => m.role === "system");
    const convo = messages.filter((m) => m.role !== "system");
    if (convo.length <= maxMessages && convo.reduce((n, m) => n + sizeOf(m), 0) <= maxChars) {
        return messages;
    }

    let lastUser = convo.length - 1;
    while (lastUser > 0 && convo[lastUser].role !== "user") lastUser--;

    let start = convo.length;
    let chars = 0;
    for (let i = convo.length - 1; i >= 0; i--) {
        const size = sizeOf(convo[i]);
        const mustKeep = i >= lastUser;
        if (!mustKeep && (convo.length - i > maxMessages || chars + size > maxChars)) break;
        chars += size;
        start = i;
    }

    while (start < lastUser && convo[start].role !== "user") start++;

    return [...system, ...convo.slice(start)];
}
