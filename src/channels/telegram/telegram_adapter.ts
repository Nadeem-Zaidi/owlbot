import { AdapterState, ChatAdapter, InboundMedia, InboundMessage } from "../core/chat_adapter";
import { renderTelegram, stripHtml } from "./telegram_format";

// Telegram through the Bot API, with long polling (getUpdates): no public
// URL or webhook needed, and nothing to install. A bot token can only be
// polled by one process at a time, so like WhatsApp it runs on one host
// (see TelegramManager).
//
// Only private chats are answered — linking is per person, and a bot in a
// group would read everyone's messages.

const POLL_TIMEOUT_S = 25;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // Bot API getFile limit

export class TelegramError extends Error {
    constructor(public code: number, message: string, public retryAfter?: number) {
        super(message);
    }
}

type Options = {
    // Tests point this at a fake server.
    apiBase?: string;
    pollTimeoutS?: number;
};

export class TelegramAdapter implements ChatAdapter {
    readonly id = "telegram";
    readonly label = "Telegram";
    private readonly apiBase: string;
    private readonly pollTimeoutS: number;
    private state: AdapterState = "disconnected";
    private username: string | null = null;
    private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
    private running = false;
    private poll: AbortController | null = null;
    private loopDone: Promise<void> = Promise.resolve();
    private offset = 0;

    constructor(private token: string, opts: Options = {}) {
        this.apiBase = (opts.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
        this.pollTimeoutS = opts.pollTimeoutS ?? POLL_TIMEOUT_S;
    }

    onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
        this.handler = handler;
    }

    status() {
        return { state: this.state, botHandle: this.username ? `@${this.username}` : undefined };
    }

    // Returns at once; connecting and polling continue in the background.
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.state = "starting";
        this.loopDone = this.loop();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.poll?.abort();
        await this.loopDone.catch(() => {});
        this.state = "disconnected";
    }

    render(markdown: string): string[] {
        return renderTelegram(markdown);
    }

    async send(chatId: string, html: string): Promise<void> {
        const body = { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
        try {
            await this.callWithRetry("sendMessage", body);
        } catch (err) {
            // Formatting Telegram can't parse: send it as plain text instead.
            if (err instanceof TelegramError && err.code === 400 && /parse entities|can't parse|unsupported start tag/i.test(err.message)) {
                await this.callWithRetry("sendMessage", { chat_id: chatId, text: stripHtml(html), link_preview_options: { is_disabled: true } });
                return;
            }
            throw err;
        }
    }

    async setTyping(chatId: string, typing: boolean): Promise<void> {
        if (typing) await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
    }

    // ── polling ──
    private async loop(): Promise<void> {
        let backoff = 1000;
        while (this.running) {
            try {
                if (!this.username) {
                    const me = await this.call<{ username: string }>("getMe");
                    this.username = me.username;
                    // Polling and a webhook can't both be active.
                    await this.call("deleteWebhook", { drop_pending_updates: false });
                    console.log(`[telegram] connected as @${this.username}`);
                }
                this.state = "connected";
                this.poll = new AbortController();
                const updates = await this.call<any[]>("getUpdates", {
                    offset: this.offset,
                    timeout: this.pollTimeoutS,
                    allowed_updates: ["message"],
                }, this.poll.signal, (this.pollTimeoutS + 10) * 1000);
                backoff = 1000;
                for (const u of updates) {
                    this.offset = Math.max(this.offset, Number(u.update_id) + 1);
                    void this.dispatch(u).catch((err) => console.error("[telegram] couldn't handle an update:", this.redact(err)));
                }
            } catch (err) {
                if (!this.running) break;
                if (err instanceof TelegramError && err.code === 401) {
                    this.state = "unauthorized";
                    this.running = false;
                    console.error("[telegram] the bot token was rejected (401) — set a valid token in Server settings");
                    break;
                }
                if (err instanceof TelegramError && err.code === 409) {
                    console.warn("[telegram] another process is already polling this bot (409) — retrying");
                } else {
                    console.warn(`[telegram] polling failed (${this.redact(err)}); retrying in ${Math.round(backoff / 1000)}s`);
                }
                this.state = "disconnected";
                await sleep(backoff);
                backoff = Math.min(30_000, backoff * 2);
            }
        }
    }

    private async dispatch(update: any): Promise<void> {
        const msg = update?.message;
        if (!msg || msg.chat?.type !== "private" || msg.from?.is_bot || !this.handler) return;
        const chatId = String(msg.chat.id);
        const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || undefined;
        let media: InboundMedia | undefined;
        try {
            if (Array.isArray(msg.photo) && msg.photo.length) {
                const largest = msg.photo[msg.photo.length - 1];
                media = { kind: "image", buffer: await this.download(largest.file_id, largest.file_size), mimetype: "image/jpeg" };
            } else if (msg.document) {
                const d = msg.document;
                const isImage = typeof d.mime_type === "string" && d.mime_type.startsWith("image/");
                media = { kind: isImage ? "image" : "document", buffer: await this.download(d.file_id, d.file_size), mimetype: d.mime_type ?? "application/octet-stream", fileName: d.file_name };
            }
        } catch (err) {
            await this.send(chatId, err instanceof TelegramError && err.code === 413
                ? "That file is too big for Telegram bots (20 MB max). Upload it on the web instead."
                : "I couldn't download that file — please try again.").catch(() => {});
            return;
        }
        await this.handler({
            chatId,
            text: String(msg.text ?? msg.caption ?? ""),
            messageId: `${chatId}:${msg.message_id}`,
            senderName,
            media,
        });
    }

    private async download(fileId: string, size?: number): Promise<Buffer> {
        if (size && size > MAX_DOWNLOAD_BYTES) throw new TelegramError(413, "file too large");
        const file = await this.call<{ file_path: string; file_size?: number }>("getFile", { file_id: fileId });
        const res = await fetch(`${this.apiBase}/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new TelegramError(res.status, "download failed");
        return Buffer.from(await res.arrayBuffer());
    }

    // ── Bot API ──
    private async call<T = any>(method: string, body?: unknown, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
        const timeout = AbortSignal.timeout(timeoutMs);
        const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body ?? {}),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const json: any = await res.json().catch(() => ({}));
        if (!json.ok) throw new TelegramError(json.error_code ?? res.status, String(json.description ?? `HTTP ${res.status}`), json.parameters?.retry_after);
        return json.result as T;
    }

    // Waits out Telegram's rate limit (429) once.
    private async callWithRetry(method: string, body: unknown): Promise<void> {
        try {
            await this.call(method, body);
        } catch (err) {
            if (err instanceof TelegramError && err.code === 429 && err.retryAfter && err.retryAfter <= 30) {
                await sleep(err.retryAfter * 1000);
                await this.call(method, body);
                return;
            }
            throw err;
        }
    }

    // Error text without the bot token.
    private redact(err: unknown): string {
        return String(err instanceof Error ? err.message : err).split(this.token).join("<token>");
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Checks a token and returns the bot's username (for Server settings).
export async function telegramBotInfo(token: string, apiBase = "https://api.telegram.org"): Promise<{ username: string }> {
    const res = await fetch(`${apiBase}/bot${token}/getMe`, { signal: AbortSignal.timeout(15_000) });
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) throw new TelegramError(json.error_code ?? res.status, json.error_code === 401 || json.error_code === 404 ? "Telegram rejected this bot token." : String(json.description ?? "Couldn't reach Telegram."));
    return { username: json.result.username };
}
