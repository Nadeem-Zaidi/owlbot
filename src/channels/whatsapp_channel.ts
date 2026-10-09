import pino from "pino";
import { AwayHandler, ChannelStatus, IChannel, IncomingMedia, IncomingMessage } from "../interfaces/ichannel";
import { rm } from "node:fs/promises";

// WhatsApp transport built on Baileys (an unofficial WhatsApp Web client).
// It only moves messages in and out; everything about users, chats and the
// LLM lives in WhatsAppBridge, so this file is the one to replace to move to
// Meta's official WhatsApp Cloud API.
//
// Baileys links a phone number the way WhatsApp Web does. That's fine for
// personal use, but WhatsApp may ban numbers that run bots this way — use a
// spare number rather than your main one.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;       // model image limit
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const SENT_ID_MEMORY = 500;
// Ignore anything older (e.g. history synced in after reconnecting).
const MAX_MESSAGE_AGE_MS = 2 * 60 * 1000;
// The away message still answers messages that arrived while the server was
// briefly disconnected (deploy, network blip) — they're delivered late.
const AWAY_MAX_AGE_MS = Number(process.env.WHATSAPP_AWAY_MAX_AGE_MINUTES ?? 30) * 60 * 1000;
// After you write in someone's chat yourself, the away message stays quiet
// there for this long — you're clearly around.
const OWNER_ACTIVE_MS = 30 * 60 * 1000;

export class WhatsAppChannel implements IChannel {
    readonly id: string = "whatsapp";
    private sock: any = null;
    private waStarted: boolean = false;
    private reconnecting: boolean = false;
    private DisconnectReason: any = null;
    private messageHandler?: (msg: IncomingMessage) => Promise<void>;
    private broadcastFn?: (method: string, params: any) => void;
    private status: ChannelStatus = { state: "disconnected" };
    // Ids of messages this process sent, so their echoes are never treated
    // as new input (that's what used to make the bot answer itself).
    private sentIds = new Set<string>();
    // Lets the bot run on your own number: messages you send to yourself
    // ("Message yourself" chat) become input. Set from the server settings and
    // switchable at runtime (setSelfChat).
    private selfChat: boolean;
    // stop() was called: don't auto-reconnect when the socket closes.
    private stopped = false;
    private warnedSelfChat = false;
    private awayHandler?: AwayHandler;
    // userPart(jid) → when you last wrote in that chat yourself
    private ownerActive = new Map<string, number>();

    constructor(private readonly authDir: string = process.env.WHATSAPP_AUTH_DIR ?? "./auth_state", selfChat = false) {
        this.selfChat = selfChat;
    }

    setSelfChat(on: boolean): void {
        if (this.selfChat === on) return;
        this.selfChat = on;
        this.warnedSelfChat = false;
        console.log(`[whatsapp] self-chat mode ${on ? "on" : "off"}`);
    }

    onBroadcast(fn: (method: string, params: any) => void): void {
        this.broadcastFn = fn;
    }

    onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
        this.messageHandler = handler;
    }

    onAway(handler: AwayHandler): void {
        this.awayHandler = handler;
    }

    isSelfChatMode(): boolean {
        return this.selfChat;
    }

    getStatus(): ChannelStatus {
        return { ...this.status };
    }

    async start(): Promise<void> {
        if (this.waStarted) return;
        this.waStarted = true;
        this.stopped = false;
        this.status = { state: "starting" };

        const baileys = await import("@whiskeysockets/baileys");
        const {
            useMultiFileAuthState,
            DisconnectReason,
            fetchLatestBaileysVersion,
            Browsers,
        } = baileys;

        const makeWASocket =
            (baileys as any).default?.makeWASocket ??
            (baileys as any).makeWASocket;

        this.DisconnectReason = DisconnectReason;
        try {
            const { version } = await fetchLatestBaileysVersion();
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
            this.createSocket(makeWASocket, state, saveCreds, version, Browsers);
        } catch (err) {
            // Let pair() try again later instead of looking "started" forever.
            this.waStarted = false;
            this.status = { state: "disconnected" };
            throw err;
        }
    }

    // (Re)starts pairing so a fresh QR is available to scan from the web app.
    // After a logout the saved credentials are dead, so they're cleared first.
    async pair(): Promise<void> {
        // Already running (connected, showing a QR, or auto-reconnecting).
        if (this.waStarted) return;
        if (this.status.state === "logged_out") {
            await rm(this.authDir, { recursive: true, force: true });
        }
        await this.start();
    }

    // Disconnects and stays disconnected (the login is kept, so start() later
    // reconnects without a new QR).
    async stop(): Promise<void> {
        this.stopped = true;
        this.waStarted = false;
        const sock = this.sock;
        this.sock = null;
        if (sock) {
            try {
                await sock.end(undefined);
            } catch {
                // already closed
            }
        }
        this.status = { state: "disconnected" };
    }

    async send(sessionKey: string, text: string): Promise<void> {
        if (!this.sock) {
            throw new Error("WhatsApp not connected. Call start() first.");
        }
        const jid = this.toJid(sessionKey);
        // On your personal number the bot only ever writes to "Message yourself",
        // whatever code path asked it to send.
        if (this.selfChat && !this.isSelfChat(jid)) {
            console.warn(`[whatsapp] self-chat mode: not sending to ${WhatsAppChannel.userPart(jid)} (only your own chat is allowed)`);
            return;
        }
        const sent = await this.sock.sendMessage(jid, { text });
        this.rememberSent(sent?.key?.id);
    }

    async sendFile(sessionKey: string, file: { buffer: Buffer; filename: string; mime: string; caption?: string }): Promise<void> {
        if (!this.sock) throw new Error("WhatsApp not connected. Call start() first.");
        const jid = this.toJid(sessionKey);
        if (this.selfChat && !this.isSelfChat(jid)) {
            console.warn(`[whatsapp] self-chat mode: not sending a file to ${WhatsAppChannel.userPart(jid)}`);
            return;
        }
        const sent = await this.sock.sendMessage(jid, { document: file.buffer, fileName: file.filename, mimetype: file.mime, caption: file.caption });
        this.rememberSent(sent?.key?.id);
    }

    async setTyping(sessionKey: string, typing: boolean): Promise<void> {
        if (!this.sock) return;
        try {
            await this.sock.sendPresenceUpdate(typing ? "composing" : "paused", this.toJid(sessionKey));
        } catch {
            // presence is cosmetic — never fail a reply over it
        }
    }

    private async maybeSendAway(sock: any, msg: any, jid: string, type: string): Promise<void> {
        if (!this.awayHandler || msg.key.fromMe) return;
        // Only messages arriving live — never history synced on reconnect.
        if (type !== "notify") return;
        // People only (phone numbers or their privacy ids), not bots or channels.
        if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) return;
        if (!hasUserContent(msg.message)) return; // reactions, edits, receipts…
        const person = canonicalJid(msg.key);
        const who = maskNumber(person);
        const ids = personIds(msg.key);
        const lastOwner = Math.max(0, ...ids.map((id) => this.ownerActive.get(id) ?? 0));
        if (Date.now() - lastOwner < OWNER_ACTIVE_MS) {
            console.log(`[whatsapp] away message skipped for ${who}: you wrote in this chat ${Math.round((Date.now() - lastOwner) / 60000)} min ago`);
            return;
        }

        // One identity per person (their phone number when WhatsApp tells us),
        // so the "once per repeat interval" record isn't split across ids.
        const decision = await this.awayHandler({ jid: person, name: msg.pushName ?? undefined });
        if (!decision) return;
        try {
            const sent = await sock.sendMessage(jid, { text: decision.text });
            this.rememberSent(sent?.key?.id);
            console.log(`[whatsapp] away message sent to ${who}`);
        } catch (err) {
            console.error("[whatsapp] couldn't send the away message:", err);
            await decision.failed().catch(() => {});
        }
    }

    private toJid(sessionKey: string): string {
        return sessionKey.replace(/^whatsapp:/, "");
    }

    private rememberSent(id?: string) {
        if (!id) return;
        this.sentIds.add(id);
        if (this.sentIds.size > SENT_ID_MEMORY) {
            this.sentIds.delete(this.sentIds.values().next().value!);
        }
    }

    // "919876543210:7@s.whatsapp.net" → "919876543210"
    private static userPart(jid?: string): string {
        return (jid ?? "").split("@")[0].split(":")[0];
    }

    private isSelfChat(remoteJid: string): boolean {
        const me = this.sock?.user;
        if (!me) return false;
        const remote = WhatsAppChannel.userPart(remoteJid);
        return remote === WhatsAppChannel.userPart(me.id) || (!!me.lid && remote === WhatsAppChannel.userPart(me.lid));
    }

    private createSocket(
        makeWASocket: any,
        state: any,
        saveCreds: any,
        version: number[],
        Browsers: any,
    ) {
        if (this.reconnecting) return;
        this.reconnecting = true;

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            browser: Browsers.ubuntu("Chrome"),
            // Only used to retry delivering a message we sent; we don't keep a
            // message store, so there's nothing to re-send.
            getMessage: async () => undefined,
        });

        this.sock = sock;
        this.reconnecting = false;

        sock.ev.on("creds.update", saveCreds);
        sock.ev.on("connection.update", (update: any) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr) {
                // Shown in the web app (Connect WhatsApp), not the terminal.
                if (this.status.state !== "awaiting_qr") {
                    console.log("[whatsapp] waiting to be paired — open the web app → Connect WhatsApp to scan the QR");
                }
                this.status = { state: "awaiting_qr", qr };
                this.broadcastFn?.("whatsapp.qr", { qrString: qr });
            }
            if (connection === "open") {
                const botNumber = WhatsAppChannel.userPart(sock.user?.id);
                this.status = { state: "connected", botNumber };
                console.log(`[whatsapp] connected as +${botNumber}${this.selfChat ? " (self-chat mode)" : ""}`);
                this.broadcastFn?.("whatsapp.status", { status: "connected" });
            }

            if (connection === "close") {
                // A socket from before stop() closing — nothing to do.
                if (this.stopped || (this.sock && this.sock !== sock)) return;
                this.sock = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === this.DisconnectReason?.loggedOut;
                this.status = { state: isLoggedOut ? "logged_out" : "disconnected" };

                console.log(`[whatsapp] disconnected — code: ${statusCode}`);

                this.broadcastFn?.("whatsapp.status", {
                    status: "disconnected",
                    code: statusCode,
                    reason: isLoggedOut ? "logged_out" : lastDisconnect?.error?.message,
                    willReconnect: !isLoggedOut,
                });

                if (isLoggedOut) {
                    console.log("[whatsapp] logged out — open the web app → Connect WhatsApp to pair again");
                    this.waStarted = false;
                } else {
                    // 515 "restart required" is the normal step right after a QR
                    // scan — reconnect immediately; otherwise back off a little.
                    const delay = statusCode === this.DisconnectReason?.restartRequired ? 500 : 5000;
                    console.log(`[whatsapp] reconnecting in ${delay / 1000}s...`);
                    setTimeout(
                        () => { if (!this.stopped) this.createSocket(makeWASocket, state, saveCreds, version, Browsers); },
                        delay,
                    );
                }
            }
        });

        sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
            // "notify" = new incoming messages. Messages you type on your own
            // phone can arrive as "append" instead, so self-chat mode accepts
            // those too — but "append" is also used for history sync, so only
            // recent messages count.
            if (type !== "notify" && !(this.selfChat && type === "append")) return;

            for (const msg of messages) {
                const sentAt = Number(msg.messageTimestamp ?? 0) * 1000;
                const age = sentAt ? Date.now() - sentAt : 0;
                // Too old for the bot to answer — but someone who wrote while we
                // were reconnecting should still get the away message.
                const lateForAway = age > MAX_MESSAGE_AGE_MS && age <= AWAY_MAX_AGE_MS && type === "notify" && this.selfChat && !msg.key?.fromMe;
                if (age > MAX_MESSAGE_AGE_MS && !lateForAway) continue;
                try {
                    await this.handleUpsert(sock, msg, type, lateForAway);
                } catch (err) {
                    console.error("[whatsapp] failed to handle message:", err);
                }
            }
        });
    }

    private async handleUpsert(sock: any, msg: any, type: string = "notify", lateOnlyAway = false): Promise<void> {
        if (!msg.message) return;
        const jid: string | undefined = msg.key.remoteJid;
        // One-to-one chats only: no groups, status updates or channels.
        if (!jid || jid.endsWith("@g.us") || jid.includes("@broadcast") || jid.endsWith("@newsletter")) return;
        if (msg.key.id && this.sentIds.has(msg.key.id)) return;
        if (msg.key.fromMe && !(this.selfChat && this.isSelfChat(jid))) {
            // You wrote in someone's chat yourself (our own sends were skipped above).
            // Remember every id this person goes by (phone number and privacy id).
            if (this.selfChat) for (const id of personIds(msg.key)) this.ownerActive.set(id, Date.now());
            if (!this.selfChat && this.isSelfChat(jid) && !this.warnedSelfChat) {
                this.warnedSelfChat = true;
                console.log("[whatsapp] ignoring a message you sent to yourself on the bot's own number — set WHATSAPP_SELF_CHAT=true to chat with the bot that way");
            }
            return;
        }
        // On your personal number (self-chat mode) the bot only talks to you, in
        // "Message yourself". Chats with other people are yours — the only thing
        // it ever sends there is your away message, when you've turned it on.
        if (this.selfChat && !this.isSelfChat(jid)) {
            await this.maybeSendAway(sock, msg, jid, type);
            return;
        }
        if (lateOnlyAway) return;

        // Disappearing-message / view-once / edited wrappers hide the real content.
        const m = unwrapMessage(msg.message);
        let text: string =
            m.conversation ??
            m.extendedTextMessage?.text ??
            m.imageMessage?.caption ??
            m.documentMessage?.caption ??
            m.documentWithCaptionMessage?.message?.documentMessage?.caption ??
            "";
        let media: IncomingMedia | undefined;

        const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage;
        if (m.imageMessage || doc) {
            const info = m.imageMessage ?? doc;
            const size = Number(info.fileLength ?? 0);
            const limit = m.imageMessage ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
            if (size > limit) {
                text = text || `[The user sent a file that is too large (${Math.round(size / 1048576)} MB).]`;
            } else {
                try {
                    const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
                    const buffer = (await downloadMediaMessage(
                        msg, "buffer", {},
                        { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage } as any
                    )) as Buffer;
                    media = {
                        kind: m.imageMessage ? "image" : "document",
                        buffer,
                        mimetype: info.mimetype ?? (m.imageMessage ? "image/jpeg" : "application/octet-stream"),
                        fileName: doc?.fileName,
                    };
                } catch (err: any) {
                    console.error("[whatsapp] media download failed:", err?.message);
                    text = text || "[The user sent a file but it could not be downloaded.]";
                }
            }
        } else if (m.audioMessage) {
            text = "[The user sent a voice message, which can't be processed yet.]";
        } else if (m.videoMessage) {
            text = "[The user sent a video, which can't be processed yet.]";
        } else if (m.locationMessage) {
            const { degreesLatitude, degreesLongitude } = m.locationMessage;
            text = `[The user shared a location: ${degreesLatitude}, ${degreesLongitude}]`;
        } else if (m.contactMessage) {
            text = `[The user shared a contact: ${m.contactMessage.displayName ?? "unknown"}]`;
        } else if (!text) {
            return; // stickers, reactions, polls, protocol messages...
        }

        await this.messageHandler?.({
            channelId: this.id,
            sessionKey: `whatsapp:${jid}`,
            senderId: jid,
            content: text.trim(),
            raw: msg,
            messageId: msg.key.id ?? undefined,
            senderName: msg.pushName ?? undefined,
            media,
        });
    }
}

// WhatsApp wraps content for disappearing messages, view-once media, edits
// and messages synced from your other devices; the real content is inside.
const WRAPPERS = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension",
    "documentWithCaptionMessage", "editedMessage", "deviceSentMessage", "botInvokeMessage"];
export function unwrapMessage(m: any): any {
    let cur = m;
    for (let depth = 0; cur && depth < 6; depth++) {
        const key = WRAPPERS.find((k) => cur[k]?.message);
        if (!key) break;
        cur = cur[key].message;
    }
    return cur;
}

// A real message from a person — not a reaction, edit, receipt or key update.
export function hasUserContent(raw: any): boolean {
    const m = unwrapMessage(raw);
    if (!m) return false;
    return !!(m.conversation || m.extendedTextMessage || m.imageMessage || m.videoMessage || m.ptvMessage || m.audioMessage ||
        m.documentMessage || m.stickerMessage || m.contactMessage || m.contactsArrayMessage || m.locationMessage ||
        m.liveLocationMessage || m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3 ||
        m.listResponseMessage || m.buttonsResponseMessage || m.templateButtonReplyMessage || m.interactiveResponseMessage ||
        m.eventMessage || m.groupInviteMessage);
}

// Every id a person shows up under: their phone number and their privacy id
// ("@lid"). WhatsApp may use either for the same chat.
export function personIds(key: any): string[] {
    const user = (jid?: string) => (jid ?? "").split("@")[0].split(":")[0];
    return [...new Set<string>([key?.remoteJid, key?.remoteJidAlt, key?.participant, key?.participantAlt].filter(Boolean).map(user))];
}

// The id to remember a person by: their phone-number jid when known.
export function canonicalJid(key: any): string {
    const ids = [key?.remoteJid, key?.remoteJidAlt].filter((j): j is string => typeof j === "string");
    const phone = ids.find((j) => j.endsWith("@s.whatsapp.net"));
    return (phone ?? ids[0] ?? "").replace(/:\d+@/, "@");
}

// "919876543210@s.whatsapp.net" → "+9198…10" for logs.
function maskNumber(jid: string): string {
    const n = jid.split("@")[0];
    return jid.endsWith("@lid") ? `privacy id …${n.slice(-4)}` : `+${n.slice(0, 4)}…${n.slice(-2)}`;
}
