import { MessageService } from "../service/message_service";
import { LLMMessage } from "../types/llm_message";

const DEFAULT_TITLES = new Set(["new chat", "new conversation"]);

// Whether this reply should give the chat a generated title: after the
// user's first message — or, for a chat still on a default title (e.g. one
// whose first reply didn't get a title), after this one. Counting stored
// user messages works for agent chats too, whose history also holds tool
// calls and system context.
export async function needsTitle(messages: MessageService, sessionId: string, userId: string, stored: LLMMessage[]): Promise<boolean> {
    if (stored.filter((m) => m.role === "user").length === 1) return true;
    try {
        const session = await messages.getSession(sessionId, userId);
        return !session.title || DEFAULT_TITLES.has(session.title.trim().toLowerCase());
    } catch {
        return false;
    }
}
