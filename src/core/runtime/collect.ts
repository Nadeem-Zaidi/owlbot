import { LLMMessage } from "../../types/llm_message";
import { CollectedReply } from "./types";

// Turns a streamed turn into plain reply text, for surfaces that send one
// message at the end (WhatsApp, schedules, pipelines) instead of streaming.
export async function collectReply(stream: AsyncIterable<LLMMessage>): Promise<CollectedReply> {
    let text = "";
    let sources: string[] = [];
    let error: string | null = null;
    let cancelled = false;
    for await (const chunk of stream) {
        const c = chunk as any;
        if (c.type === "message" && c.role === "assistant" && Array.isArray(c.content)) {
            for (const part of c.content) if (part?.type === "text") text += part.text ?? "";
        } else if (c.type === "function_call" && text && !text.endsWith("\n")) {
            text += "\n\n"; // separate pre-tool text from the answer
        } else if (c.type === "sources" && Array.isArray(c.sources)) {
            sources = c.sources;
        } else if (c.isDone && Array.isArray(c.sources)) {
            sources = c.sources;
        } else if (c.type === "error") {
            error = c.message ?? "Something went wrong.";
        } else if (c.type === "cancelled") {
            cancelled = true;
        }
    }
    return { text, sources, error, cancelled };
}
