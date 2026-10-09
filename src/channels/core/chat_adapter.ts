// Contracts between the generic chat bridge and each messaging app
// (WhatsApp, Telegram, …). An adapter only moves messages in and out and
// knows its app's formatting; linking, commands, documents and answering
// live once in ChatBridge.

export type InboundMedia = {
    kind: "image" | "document";
    buffer: Buffer;
    mimetype: string;
    fileName?: string;
};

export type InboundMessage = {
    // The conversation on the app's side (WhatsApp jid, Telegram chat id).
    chatId: string;
    // Text or caption ("" for media only).
    text: string;
    // For de-duplicating redelivered messages.
    messageId?: string;
    senderName?: string;
    media?: InboundMedia;
};

export type AdapterState = "starting" | "awaiting_qr" | "connected" | "disconnected" | "logged_out" | "unauthorized";

export type AdapterStatus = {
    state: AdapterState;
    // How users find the bot: a phone number (WhatsApp) or @username (Telegram).
    botHandle?: string;
};

export interface ChatAdapter {
    // Also the `source` of chats started here ("whatsapp", "telegram").
    readonly id: string;
    readonly label: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
    // Markdown in → message-sized pieces in the app's own formatting.
    render(markdown: string): string[];
    // Sends one piece produced by render().
    send(chatId: string, text: string): Promise<void>;
    setTyping?(chatId: string, typing: boolean): Promise<void>;
    // Sends a file (e.g. a generated Word/Excel document) as an attachment.
    sendFile?(chatId: string, file: OutboundFile): Promise<void>;
    status(): AdapterStatus;
}

export type OutboundFile = { buffer: Buffer; filename: string; mime: string; caption?: string };

// Which web account a chat on the app belongs to.
export type ChannelLink = {
    chatId: string;
    userId: string;
    displayName: string | null;
    activeSessionId: string | null;
    provider: string | null;
    model: string | null;
    linkedAt: Date;
};

export interface ChannelLinkStore {
    // Single-use code from the web app; null if unknown, used or expired.
    consumeCode(code: string): Promise<{ userId: string; sessionId: string | null } | null>;
    getByChat(chatId: string): Promise<ChannelLink | null>;
    getByUser(userId: string): Promise<ChannelLink | null>;
    // Replaces any earlier link of this user or of this chat.
    link(chatId: string, userId: string, displayName: string | null, sessionId: string | null): Promise<void>;
    setActiveSession(chatId: string, sessionId: string | null): Promise<void>;
    setModel(chatId: string, provider: string, model: string): Promise<void>;
    unlinkChat(chatId: string): Promise<void>;
}

// The user's agents, for /agents and /agent.
export type AgentDirectory = {
    list(userId: string): Promise<{ id: string; name: string; icon: string | null }[]>;
    // A new chat (with the given source) attached to the agent; returns its id.
    startChat(userId: string, agentId: string, source: string): Promise<string>;
};
