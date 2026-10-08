import { IChannel } from "../interfaces/ichannel";
import { WhatsAppRepository } from "../repository/whatsapp_repository";
import { ChannelLink, ChannelLinkStore, ChatAdapter, InboundMessage } from "./core/chat_adapter";
import { chunkMessage, toWhatsApp } from "./whatsapp_format";

// The WhatsApp channel (Baileys) as a ChatAdapter. Chat ids are WhatsApp
// jids; the channel itself addresses chats as "whatsapp:<jid>".
export class WhatsAppAdapter implements ChatAdapter {
    readonly id = "whatsapp";
    readonly label = "WhatsApp";

    constructor(readonly channel: IChannel) {}

    start() { return this.channel.start(); }
    stop() { return this.channel.stop(); }

    onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
        this.channel.onMessage((m) => handler({
            chatId: m.senderId,
            text: typeof m.content === "string" ? m.content : "",
            messageId: m.messageId,
            senderName: m.senderName,
            media: m.media,
        }));
    }

    render(markdown: string): string[] {
        return chunkMessage(toWhatsApp(markdown));
    }

    send(chatId: string, text: string) {
        return this.channel.send(`whatsapp:${chatId}`, text);
    }

    async setTyping(chatId: string, typing: boolean) {
        await this.channel.setTyping?.(`whatsapp:${chatId}`, typing);
    }

    status() {
        const s = this.channel.getStatus?.() ?? { state: "disconnected" as const };
        return { state: s.state, botHandle: s.botNumber };
    }
}

// whatsapp_links / whatsapp_link_codes as a ChannelLinkStore (WhatsApp keeps
// its own tables; newer channels use channel_links).
export function whatsappLinkStore(repo: WhatsAppRepository): ChannelLinkStore {
    const toLink = (l: any): ChannelLink | null => l && ({
        chatId: l.jid,
        userId: l.user_id,
        displayName: l.display_name ?? null,
        activeSessionId: l.active_session_id ?? null,
        provider: l.provider ?? null,
        model: l.model ?? null,
        linkedAt: l.linked_at,
    });
    return {
        consumeCode: async (code) => {
            const c = await repo.consumeCode(code);
            return c ? { userId: c.user_id, sessionId: c.session_id } : null;
        },
        getByChat: async (chatId) => toLink(await repo.getByJid(chatId)),
        getByUser: async (userId) => toLink(await repo.getByUser(userId)),
        link: (chatId, userId, name, sessionId) => repo.link(chatId, userId, name, sessionId),
        setActiveSession: (chatId, sessionId) => repo.setActiveSession(chatId, sessionId),
        setModel: (chatId, provider, model) => repo.setModel(chatId, provider, model),
        unlinkChat: (chatId) => repo.unlinkJid(chatId),
    };
}
