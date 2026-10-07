import { AwayDecision, AwayRequest, IChannel, IncomingMessage } from "../interfaces/ichannel";
import { ILLM } from "../interfaces/illm";
import { LLMProvider } from "../llms/llm_factory";
import { WhatsAppLink, WhatsAppRepository } from "../repository/whatsapp_repository";
import { ContentPart, LLMMessage } from "../types/llm_message";
import { chunkMessage, toWhatsApp } from "../channels/whatsapp_format";
import { KnowledgeBase } from "./knowledge_base";
import { MessageService } from "./message_service";
import { buildExplainDocumentParts } from "./explain_document";
import { ModelRegistry } from "./model_registry";

type BridgeDeps = {
    channel: IChannel;
    repo: WhatsAppRepository;
    messageService: MessageService;
    providers: Map<LLMProvider, ILLM>;
    defaultProvider: LLMProvider;
    kb: KnowledgeBase;
    // Server providers + the user's own keys (BYOK).
    registry?: ModelRegistry;
};

const PROVIDER_LABELS: Record<string, string> = { openai: "ChatGPT", anthropic: "Claude" };
const LINK_CODE = /\bOWL-[A-HJ-NP-Z2-9]{6}\b/i;
const REPLY_TIMEOUT_MS = 4 * 60 * 1000;
const NUDGE_INTERVAL_MS = 30 * 60 * 1000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const HELP = [
    "*Owl Bot* — ask me anything, or about your documents.",
    "",
    "/new — start a new chat",
    "/docs — list your knowledge base",
    "/explain 2 — detailed walkthrough of a document",
    "/model — switch between ChatGPT and Claude",
    "/unlink — disconnect this number",
    "",
    "Send a PDF or document to add it to your knowledge base. Send a photo to ask about it.",
].join("\n");

// Connects a chat channel (WhatsApp) to the same conversation engine the web
// app uses: same sessions and chat_messages tables, same providers, same RAG
// tool. A phone number only gets answers once it's linked to a web account
// with a one-time code, so strangers can't use (and bill) the bot.
export class WhatsAppBridge {
    private queues = new Map<string, Promise<void>>();
    private seenIds = new Set<string>();
    // The last numbered list shown (sources or /docs), for "/explain 2".
    private lastList = new Map<string, string[]>();
    private lastNudge = new Map<string, number>();

    constructor(private deps: BridgeDeps) {}

    start(): void {
        this.deps.channel.onMessage(async (msg) => this.enqueue(msg));
        this.deps.channel.onAway?.((req) => this.awayReply(req));
    }

    selfChatMode(): boolean {
        return this.deps.channel.isSelfChatMode?.() ?? false;
    }

    // Away message for someone writing to your number: once per person per
    // cooldown, while it's on and before its end time.
    async awayReply(req: AwayRequest): Promise<AwayDecision> {
        const away = await this.deps.repo.getAway();
        if (!away.enabled || !away.message.trim()) return null;
        if (away.until && new Date(away.until).getTime() <= Date.now()) {
            console.log("[whatsapp] away message ended (its end time passed) — turned off");
            await this.deps.repo.disableAway();
            return null;
        }
        if (!(await this.deps.repo.claimAwayReply(req.jid, req.name ?? null, away.cooldown_minutes))) {
            const hours = Math.round(away.cooldown_minutes / 6) / 10;
            console.log(`[whatsapp] away message skipped for ${maskJid(req.jid)}: already sent in the last ${hours} h (repeat interval)`);
            return null;
        }
        return { text: renderAway(away.message, req.name), failed: () => this.deps.repo.releaseAwayReply(req.jid) };
    }

    status() {
        return this.deps.channel.getStatus?.() ?? { state: "disconnected" as const };
    }

    async pairBot(): Promise<void> {
        await this.deps.channel.pair?.();
    }

    // Sends a message to a user's linked WhatsApp (e.g. a scheduled agent's
    // result). False if they haven't linked a number or the bot is offline.
    async notifyUser(userId: string, markdown: string): Promise<boolean> {
        const link = await this.deps.repo.getByUser(userId);
        if (!link || this.status().state !== "connected") return false;
        await this.reply(link.jid, toWhatsApp(markdown));
        return true;
    }

    // Web "Continue in WhatsApp" for an already-linked number: switch the
    // phone to that chat and tell the user so in WhatsApp.
    async continueSession(userId: string, sessionId: string): Promise<boolean> {
        const link = await this.deps.repo.getByUser(userId);
        if (!link) return false;
        const session = await this.deps.messageService.getSession(sessionId, userId);
        await this.deps.repo.setActiveSession(link.jid, sessionId);
        await this.reply(link.jid, `📎 Continuing *${session.title || "your chat"}* here. Send your next message.`);
        return true;
    }

    // Messages from one number are handled strictly in order; different
    // numbers run in parallel.
    private enqueue(msg: IncomingMessage): Promise<void> {
        if (msg.messageId) {
            if (this.seenIds.has(msg.messageId)) return Promise.resolve();
            this.seenIds.add(msg.messageId);
            if (this.seenIds.size > 1000) this.seenIds.delete(this.seenIds.values().next().value!);
        }
        const jid = msg.senderId;
        const run = (this.queues.get(jid) ?? Promise.resolve())
            .then(() => this.handle(msg))
            .catch(async (err) => {
                console.error(`[whatsapp-bridge] error handling message from ${jid}:`, err);
                await this.reply(jid, "⚠️ Sorry, something went wrong. Please try again.").catch(() => {});
            });
        this.queues.set(jid, run);
        void run.finally(() => {
            if (this.queues.get(jid) === run) this.queues.delete(jid);
        });
        return run;
    }

    private async handle(msg: IncomingMessage): Promise<void> {
        const jid = msg.senderId;
        const text = typeof msg.content === "string" ? msg.content : "";

        const code = text.match(LINK_CODE)?.[0];
        if (code) return this.handleLinkCode(jid, code, msg.senderName);

        const link = await this.deps.repo.getByJid(jid);
        if (!link) return this.nudgeUnlinked(jid);

        if (text.startsWith("/")) return this.handleCommand(link, text);

        if (msg.media?.kind === "document") return this.ingestDocument(link, msg, text);

        const parts: ContentPart[] = [];
        if (msg.media?.kind === "image") {
            const mediaType = msg.media.mimetype.split(";")[0];
            if (!IMAGE_TYPES.has(mediaType)) {
                return this.reply(jid, "That image format isn't supported — try a JPG or PNG.");
            }
            parts.push({ type: "text", text: text || "What's in this image?" });
            parts.push({
                type: "input_base64_image",
                source: { type: "base64", media_type: mediaType as any, data: msg.media.buffer.toString("base64") },
            } as ContentPart);
        } else if (text) {
            parts.push({ type: "text", text });
        } else {
            return;
        }
        await this.ask(link, parts);
    }

    private async handleLinkCode(jid: string, code: string, senderName?: string): Promise<void> {
        const consumed = await this.deps.repo.consumeCode(code);
        if (!consumed) {
            return this.reply(jid, "That code is invalid or has expired. Generate a new one in Owl Bot → *Connect WhatsApp*.");
        }
        const existing = await this.deps.repo.getByJid(jid);
        if (existing && existing.user_id === consumed.user_id) {
            if (consumed.session_id) await this.deps.repo.setActiveSession(jid, consumed.session_id);
        } else {
            await this.deps.repo.link(jid, consumed.user_id, senderName ?? null, consumed.session_id);
        }

        if (consumed.session_id) {
            const session = await this.deps.messageService.getSession(consumed.session_id, consumed.user_id);
            return this.reply(jid, `✅ Linked. Continuing *${session.title || "your chat"}* here — send your next message.`);
        }
        return this.reply(jid, `✅ This number is now linked to your Owl Bot account.\n\n${HELP}`);
    }

    private async nudgeUnlinked(jid: string): Promise<void> {
        const last = this.lastNudge.get(jid) ?? 0;
        if (Date.now() - last < NUDGE_INTERVAL_MS) return;
        this.lastNudge.set(jid, Date.now());
        const web = process.env.WEB_APP_URL ? ` (${process.env.WEB_APP_URL})` : "";
        await this.reply(
            jid,
            `👋 Hi! I'm Owl Bot. This number isn't linked to an account yet.\n\nOpen Owl Bot on the web${web} → *Connect WhatsApp*, then send the code here.`
        );
    }

    private async handleCommand(link: WhatsAppLink, text: string): Promise<void> {
        const [rawCmd, ...rest] = text.trim().split(/\s+/);
        const cmd = rawCmd.toLowerCase();
        const arg = rest.join(" ").trim();
        const jid = link.jid;

        switch (cmd) {
            case "/help":
            case "/start":
                return this.reply(jid, HELP);

            case "/new": {
                const session = await this.deps.messageService.createSession(link.user_id, "whatsapp", "WhatsApp chat");
                await this.deps.repo.setActiveSession(jid, session.id);
                return this.reply(jid, "🆕 Started a new chat. What would you like to talk about?");
            }

            case "/docs": {
                const docs = (await this.deps.kb.listDocuments(link.user_id)).slice(0, 20);
                if (!docs.length) return this.reply(jid, "Your knowledge base is empty. Send me a PDF or document to add one.");
                this.lastList.set(jid, docs.map((d) => d.key));
                const lines = docs.map((d, i) => `${i + 1}. ${d.name}`);
                return this.reply(jid, `📚 *Your documents*\n${lines.join("\n")}\n\nReply /explain <number> for a detailed walkthrough.`);
            }

            case "/explain":
                return this.explain(link, arg);

            case "/model":
                return this.switchModel(link, arg);

            case "/unlink":
                await this.deps.repo.unlinkJid(jid);
                return this.reply(jid, "This number has been unlinked. Connect it again any time from Owl Bot on the web.");

            default:
                return this.reply(jid, `I don't know that command.\n\n${HELP}`);
        }
    }

    private async explain(link: WhatsAppLink, arg: string): Promise<void> {
        const jid = link.jid;
        if (!arg) return this.reply(jid, "Which document? Send /docs to see the list, then /explain <number>.");

        let key: string | undefined;
        const n = Number(arg);
        if (Number.isInteger(n) && n > 0) {
            key = this.lastList.get(jid)?.[n - 1];
            if (!key) return this.reply(jid, "I don't have a numbered list for that yet — send /docs first.");
        } else {
            const docs = await this.deps.kb.listDocuments(link.user_id);
            key = docs.find((d) => d.name.toLowerCase().includes(arg.toLowerCase()))?.key;
            if (!key) return this.reply(jid, `No document matching “${arg}”. Send /docs to see the list.`);
        }

        const doc = await this.deps.kb.readDocument(link.user_id, key);
        if (!doc) return this.reply(jid, "That document isn't in your knowledge base anymore.");
        await this.reply(jid, `📖 Reading *${doc.name}*…${doc.truncated ? " (it's long, so I'll cover the first part)" : ""}`);
        await this.ask(link, buildExplainDocumentParts(doc) as ContentPart[]);
    }

    private async switchModel(link: WhatsAppLink, arg: string): Promise<void> {
        // The server's models plus the user's own keys.
        const options = this.deps.registry
            ? (await this.deps.registry.listFor(link.user_id)).providers.flatMap((p) =>
                p.models.map((m) => ({ provider: p.id, model: m.id, providerLabel: p.label })))
            : [...this.deps.providers.entries()].flatMap(([provider, llm]) =>
                (llm.getModels?.() ?? [llm.getModel()]).map((model) => ({ provider: provider as string, model, providerLabel: PROVIDER_LABELS[provider] ?? provider })));
        const current = await this.pickLLM(link);
        const label = (o: { providerLabel: string; model: string }) => `${o.providerLabel} · ${o.model}`;

        if (!arg) {
            const lines = options.map((o, i) => `${i + 1}. ${label(o)}${o.provider === current.provider && o.model === current.model ? "  ✓" : ""}`);
            return this.reply(link.jid, `🤖 *Model*\n${lines.join("\n")}\n\nReply /model <number> to switch.`);
        }
        const n = Number(arg);
        const choice = Number.isInteger(n) && n > 0
            ? options[n - 1]
            : options.find((o) => label(o).toLowerCase().includes(arg.toLowerCase()));
        if (!choice) return this.reply(link.jid, "I couldn't find that model. Send /model to see the list.");
        await this.deps.repo.setModel(link.jid, choice.provider, choice.model);
        return this.reply(link.jid, `Switched to *${label(choice)}*.`);
    }

    private async pickLLM(link: WhatsAppLink): Promise<{ provider: string; model: string; llm: ILLM }> {
        if (this.deps.registry) {
            const r = await this.deps.registry.resolve(link.user_id, link.provider, link.model);
            return { provider: r.provider, model: r.model, llm: r.llm };
        }
        const preferred = link.provider as LLMProvider | null;
        const provider = preferred && this.deps.providers.has(preferred) ? preferred : this.deps.defaultProvider;
        const llm = this.deps.providers.get(provider)!;
        const models = llm.getModels?.() ?? [llm.getModel()];
        const model = link.model && models.includes(link.model) ? link.model : llm.getModel();
        return { provider, model, llm };
    }

    private async ingestDocument(link: WhatsAppLink, msg: IncomingMessage, caption: string): Promise<void> {
        const media = msg.media!;
        const name = (media.fileName ?? `whatsapp-${Date.now()}`).replace(/[\\/]/g, "_");
        await this.reply(link.jid, `⏳ Adding *${name}* to your knowledge base…`);

        const outcome = await this.deps.kb.ingest(
            { buffer: media.buffer, originalname: name, mimetype: media.mimetype },
            `${link.user_id}/`
        );
        if (outcome.status === "failed") {
            return this.reply(link.jid, `❌ Couldn't add *${name}*: ${outcome.error}`);
        }
        if (!outcome.sections) {
            return this.reply(link.jid, `Saved *${name}*, but I couldn't read any text from it, so it can't be searched.`);
        }
        this.lastList.set(link.jid, [`${link.user_id}/${name}`]);
        await this.reply(
            link.jid,
            `✅ Added *${name}* (${outcome.sections} section${outcome.sections === 1 ? "" : "s"}). Ask me about it, or reply /explain 1 for a walkthrough.`
        );
        if (caption) await this.ask(link, [{ type: "text", text: caption }]);
    }

    // Runs one user turn through the provider and sends the reply.
    private async ask(link: WhatsAppLink, parts: ContentPart[]): Promise<void> {
        const jid = link.jid;
        const sessionId = await this.ensureSession(link);
        const { llm, model } = await this.pickLLM(link);
        const message: LLMMessage = { type: "message", role: "user", content: parts };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REPLY_TIMEOUT_MS);
        const typing = setInterval(() => void this.deps.channel.setTyping?.(`whatsapp:${jid}`, true), 8000);
        await this.deps.channel.setTyping?.(`whatsapp:${jid}`, true);

        let text = "";
        let sources: string[] = [];
        let error: string | null = null;
        try {
            // apiKey is only read by the OpenAI provider (raw fetch calls).
            for await (const chunk of llm.chatStream([message], link.user_id, sessionId, process.env.OPENAI_API_KEY ?? "", controller.signal, model)) {
                if (chunk.type === "message" && chunk.role === "assistant" && Array.isArray(chunk.content)) {
                    for (const part of chunk.content as any[]) if (part?.type === "text") text += part.text ?? "";
                } else if (chunk.type === "function_call" && text && !text.endsWith("\n")) {
                    text += "\n\n"; // separate pre-tool text from the answer
                } else if (chunk.type === "sources" && Array.isArray((chunk as any).sources)) {
                    sources = (chunk as any).sources;
                } else if (chunk.isDone && Array.isArray(chunk.sources)) {
                    sources = chunk.sources;
                } else if (chunk.type === "error") {
                    error = chunk.message ?? "Something went wrong.";
                } else if (chunk.type === "cancelled") {
                    error = "That took too long, so I stopped. Try a shorter question.";
                }
            }
        } finally {
            clearTimeout(timeout);
            clearInterval(typing);
            await this.deps.channel.setTyping?.(`whatsapp:${jid}`, false);
        }

        if (!text.trim()) {
            return this.reply(jid, `⚠️ ${error ?? "I couldn't come up with a reply. Please try again."}`);
        }

        let body = toWhatsApp(text);
        if (sources.length) {
            this.lastList.set(jid, sources);
            const list = sources.map((s, i) => `${i + 1}. ${s.split("/").pop() || s}`).join("\n");
            body += `\n\n📄 *Sources*\n${list}\nReply /explain <number> for a detailed walkthrough.`;
        }
        if (error) body += `\n\n⚠️ ${error}`;
        await this.reply(jid, body);
    }

    private async ensureSession(link: WhatsAppLink): Promise<string> {
        if (link.active_session_id && (await this.deps.messageService.isSessionValid(link.active_session_id, link.user_id))) {
            return link.active_session_id;
        }
        const session = await this.deps.messageService.createSession(link.user_id, "whatsapp", "WhatsApp chat");
        await this.deps.repo.setActiveSession(link.jid, session.id);
        link.active_session_id = session.id;
        return session.id;
    }

    private async reply(jid: string, text: string): Promise<void> {
        for (const chunk of chunkMessage(text)) {
            await this.deps.channel.send(`whatsapp:${jid}`, chunk);
        }
    }
}

// {name} → the sender's WhatsApp name (first word), or "there".
export function renderAway(template: string, name?: string): string {
    const first = (name ?? "").trim().split(/\s+/)[0] || "there";
    return template.replace(/\{name\}/gi, first).trim();
}

// "919876543210@s.whatsapp.net" → "+9198…10" for logs (never a full number).
function maskJid(jid: string): string {
    const n = jid.split("@")[0];
    return jid.endsWith("@lid") ? `privacy id …${n.slice(-4)}` : `+${n.slice(0, 4)}…${n.slice(-2)}`;
}
