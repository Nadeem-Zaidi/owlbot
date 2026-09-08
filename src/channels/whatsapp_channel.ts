import pino from "pino";
import { IChannel, IncomingMessage } from "../interfaces/ichannel";
import qrcode from "qrcode-terminal";

export class WhatsAppChannel implements IChannel {
    readonly id: string = "whatsapp";
    private sock: any = null;
    private waStarted: boolean = false;
    private reconnecting: boolean = false;
    private msgStore = new Map<string, any>();
    private DisconnectReason: any = null;
    private messageHandler?: (msg: IncomingMessage) => Promise<void>;
    private broadcastFn?: (method: string, params: any) => void;

    onBroadcast(fn: (method: string, params: any) => void): void {
        this.broadcastFn = fn;
    }

    onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
        this.messageHandler = handler;
    }

    async start(): Promise<void> {
        if (this.waStarted) return;
        this.waStarted = true;

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
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState('./auth_state');
        this.createSocket(makeWASocket, state, saveCreds, version, Browsers);
    }

    async stop(): Promise<void> {
        if (this.sock) {
            await this.sock.end();
            this.sock = null;
        }
    }

    async send(sessionKey: string, text: string): Promise<void> {
        if (!this.sock) {
            throw new Error("WhatsApp not connected. Call start() first.");
        }
        const jid = sessionKey.replace("whatsapp:", "");
        await this.sock.sendMessage(jid, { text });
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
            getMessage: async (key: any) =>
                this.msgStore.get(key.id ?? "") ?? { conversation: "" },
        });

        this.sock = sock;
        this.reconnecting = false;

        sock.ev.on("creds.update", saveCreds);
        sock.ev.on("connection.update", (update: any) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr) {
                console.log("\n[whatsapp] Scan this QR in WhatsApp:\n");
                qrcode.generate(qr, { small: true });
                const qrImageUrl =
                    `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=` +
                    encodeURIComponent(qr);
                this.broadcastFn?.("whatsapp.qr", { qrString: qr, qrImageUrl });
            }
            if (connection === "open") {
                console.log("[whatsapp] connected");
                this.broadcastFn?.("whatsapp.status", { status: "connected" });
            }

            if (connection === "close") {
                this.sock = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === this.DisconnectReason?.loggedOut;

                console.log(`[whatsapp] disconnected — code: ${statusCode}`);

                this.broadcastFn?.("whatsapp.status", {
                    status: "disconnected",
                    code: statusCode,
                    reason: isLoggedOut ? "logged_out" : lastDisconnect?.error?.message,
                    willReconnect: !isLoggedOut,
                });

                if (isLoggedOut) {
                    console.log("[whatsapp] logged out — delete ./auth_state and reconnect");
                    this.waStarted = false;
                } else {
                    console.log("[whatsapp] reconnecting in 5s...");
                    setTimeout(
                        () => this.createSocket(makeWASocket, state, saveCreds, version, Browsers),
                        5000,
                    );
                }
            }
        });

        sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
            if (type !== "notify") return;

            for (const msg of messages) {
                if (!msg.message) continue;

                const jid = msg.key.remoteJid;
                if (!jid || jid.includes("@broadcast")) continue;

                // skip bot's own messages — prevents infinite loop
                // if (msg.key.fromMe) continue;

                // save to store for getMessage() lookups
                if (msg.key.id) {
                    this.msgStore.set(msg.key.id, msg.message);
                }

                let content: string | any[] | null = null;
                if (msg.message.conversation || msg.message.extendedTextMessage) {
                    content =
                        msg.message.conversation ??
                        msg.message.extendedTextMessage?.text ??
                        null;
                } else if (msg.message.imageMessage) {
                    try {
                        const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
                        const buffer = await downloadMediaMessage(
                            msg, "buffer", {},
                            {
                                logger: pino({ level: "silent" }),
                                reuploadRequest: sock.updateMediaMessage,
                            }
                        );
                        content = [
                            { type: "text", text: "Describe this image" },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/jpeg;base64,${(buffer as Buffer).toString("base64")}`,
                                },
                            },
                        ];
                    } catch (err: any) {
                        console.error("[whatsapp] image download failed:", err.message);
                        content = "User sent an image but it could not be downloaded.";
                    }

                } else if (msg.message.stickerMessage) {
                    content = "User sent a sticker. Respond playfully.";

                } else if (msg.message.audioMessage) {
                    content = "User sent a voice message. Let them know you cannot process audio yet.";
                } else if (msg.message.videoMessage) {
                    content = "User sent a video. Let them know you cannot process video yet.";

                } else if (msg.message.documentMessage) {
                    const fileName = msg.message.documentMessage.fileName ?? "unknown file";
                    content = `User sent a document: ${fileName}. Let them know you cannot process documents yet.`;

                } else if (msg.message.locationMessage) {
                    const { degreesLatitude, degreesLongitude } = msg.message.locationMessage;
                    content = `User sent their location: latitude ${degreesLatitude}, longitude ${degreesLongitude}.`;

                } else if (msg.message.contactMessage) {
                    const name = msg.message.contactMessage.displayName ?? "unknown";
                    content = `User shared a contact: ${name}.`;

                } else {
                    console.log("[whatsapp] skipping unsupported message type");
                    continue;
                }

                if (!content) continue;

                await this.messageHandler?.({
                    channelId: this.id,
                    sessionKey: `whatsapp:${jid}`,
                    senderId: jid,
                    content: `${content!}`,
                    raw: msg,
                });
            }
        });
    }
}