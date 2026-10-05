export type IncomingMedia = {
    kind: "image" | "document";
    buffer: Buffer;
    mimetype: string;
    fileName?: string;
};

export type IncomingMessage={
    channelId:string;
    sessionKey:string;
    senderId:string;
    // Text (or caption) of the message; empty when it's media only.
    content:string|any[];
    raw:any;
    messageId?:string;
    senderName?:string;
    media?:IncomingMedia;
}

export type ChannelState = "starting" | "awaiting_qr" | "connected" | "disconnected" | "logged_out";

export type ChannelStatus = {
    state: ChannelState;
    // The bot's own number in international format without "+", e.g. "919876543210".
    botNumber?: string;
    // Raw pairing QR string while state is "awaiting_qr".
    qr?: string;
};

export interface IChannel{
    readonly id:string;
    start():Promise<void>;
    stop():Promise<void>;
    send(sessionKey:string,text:string):Promise<void>;
    onMessage(handler:(msg:IncomingMessage)=>Promise<void>):void
    // Optional extras a chat-app channel can offer.
    setTyping?(sessionKey:string,typing:boolean):Promise<void>;
    getStatus?():ChannelStatus;
    // Starts (or restarts) pairing so a fresh QR becomes available.
    pair?():Promise<void>;
    // Away message: asked when someone else writes to your own number
    // (self-chat mode). Return the text to send, or null to stay quiet.
    onAway?(handler: AwayHandler): void;
    isSelfChatMode?(): boolean;
}

export type AwayRequest = { jid: string; name?: string };
export type AwayDecision = { text: string; failed: () => Promise<void> } | null;
export type AwayHandler = (req: AwayRequest) => Promise<AwayDecision>;
