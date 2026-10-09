import { AgentRuntime, RunChannel } from "../../core/runtime";
import { ILLM } from "../../interfaces/illm";
import { LLMProvider } from "../../llms/llm_factory";
import { buildExplainDocumentParts } from "../../service/explain_document";
import { KnowledgeBase } from "../../service/knowledge_base";
import { MessageService } from "../../service/message_service";
import { ModelRegistry } from "../../service/model_registry";
import { ContentPart, LLMMessage } from "../../types/llm_message";
import { AgentDirectory, ChannelLink, ChannelLinkStore, ChatAdapter, InboundMessage } from "./chat_adapter";
import { metrics } from "../../infra/observability";

export type ChatBridgeDeps = {
    adapter: ChatAdapter;
    links: ChannelLinkStore;
    messageService: MessageService;
    providers: Map<LLMProvider, ILLM>;
    defaultProvider: LLMProvider;
    kb: KnowledgeBase;
    // Server providers + the user's own keys (BYOK).
    registry?: ModelRegistry;
    // Runs each turn — the same runtime as the web app. Built from the deps
    // above when not given (tests).
    runtime?: AgentRuntime;
    agents?: AgentDirectory;
    // Loads a generated Word/Excel file so it can be sent as an attachment.
    files?: (userId: string, fileId: string) => Promise<{ buffer: Buffer; filename: string; mime: string }>;
};

const PROVIDER_LABELS: Record<string, string> = { openai: "ChatGPT", anthropic: "Claude" };
const LINK_CODE = /\bOWL-[A-HJ-NP-Z2-9]{6}\b/i;
const REPLY_TIMEOUT_MS = 4 * 60 * 1000;
const NUDGE_INTERVAL_MS = 30 * 60 * 1000;
const TYPING_REFRESH_MS = 4_500; // Telegram's indicator lasts ~5 s; WhatsApp's longer
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Connects a messaging app to the same conversation engine as the web app:
// same sessions and messages, same runtime (agents, memory, RAG). A chat
// only gets answers once it's linked to a web account with a one-time code,
// so strangers can't use (and bill) the bot.
//
// All texts are Markdown; the adapter turns them into its app's formatting.
export class ChatBridge {
    private queues = new Map<string, Promise<void>>();
    private seenIds = new Set<string>();
    // The last numbered list shown (sources or /docs), for "/explain 2".
    private lastList = new Map<string, string[]>();
    // The last /agents list shown, for "/agent 2".
    private lastAgents = new Map<string, string[]>();
    private lastNudge = new Map<string, number>();
    protected readonly runtime: AgentRuntime;

    constructor(protected deps: ChatBridgeDeps) {
        this.runtime = deps.runtime ?? new AgentRuntime({
            messageService: deps.messageService,
            providers: deps.providers,
            defaultProvider: deps.defaultProvider,
            registry: deps.registry,
            kb: deps.kb,
            apiKey: process.env.OPENAI_API_KEY ?? "",
        });
    }

    get adapter(): ChatAdapter {
        return this.deps.adapter;
    }

    start(): void {
        this.deps.adapter.onMessage(async (msg) => this.enqueue(msg));
    }

    status() {
        return this.deps.adapter.status();
    }

    protected get help(): string {
        return [
            "**Owl Bot** — ask me anything, or about your documents.",
            "",
            "/new — start a new chat",
            "/docs — list your knowledge base",
            "/explain 2 — detailed walkthrough of a document",
            "/model — switch between ChatGPT and Claude",
            ...(this.deps.agents ? ["/agents — chat with one of your agents"] : []),
            `/unlink — disconnect this ${this.adapter.id === "whatsapp" ? "number" : "chat"}`,
            "",
            "Send a PDF or document to add it to your knowledge base. Send a photo to ask about it.",
        ].join("\n");
    }

    // Sends a message to a user's linked chat (e.g. a scheduled agent's
    // result). False if they haven't linked one or the bot is offline.
    async notifyUser(userId: string, markdown: string): Promise<boolean> {
        const link = await this.deps.links.getByUser(userId);
        if (!link || this.status().state !== "connected") return false;
        await this.reply(link.chatId, markdown);
        return true;
    }

    // Web "Continue in <app>" for an already-linked chat: switch it to that
    // chat and tell the user so in the app.
    async continueSession(userId: string, sessionId: string): Promise<boolean> {
        const link = await this.deps.links.getByUser(userId);
        if (!link) return false;
        const session = await this.deps.messageService.getSession(sessionId, userId);
        await this.deps.links.setActiveSession(link.chatId, sessionId);
        await this.reply(link.chatId, `📎 Continuing **${session.title || "your chat"}** here. Send your next message.`);
        return true;
    }

    // Messages from one chat are handled strictly in order; different chats
    // run in parallel.
    private enqueue(msg: InboundMessage): Promise<void> {
        if (msg.messageId) {
            if (this.seenIds.has(msg.messageId)) return Promise.resolve();
            this.seenIds.add(msg.messageId);
            if (this.seenIds.size > 1000) this.seenIds.delete(this.seenIds.values().next().value!);
        }
        const chatId = msg.chatId;
        metrics.channelMessages.inc({ channel: this.adapter.id, direction: "in" });
        const run = (this.queues.get(chatId) ?? Promise.resolve())
            .then(() => this.handle(msg))
            .catch(async (err) => {
                console.error(`[${this.adapter.id}-bridge] error handling a message:`, err);
                await this.reply(chatId, "⚠️ Sorry, something went wrong. Please try again.").catch(() => {});
            });
        this.queues.set(chatId, run);
        void run.finally(() => {
            if (this.queues.get(chatId) === run) this.queues.delete(chatId);
        });
        return run;
    }

    private async handle(msg: InboundMessage): Promise<void> {
        const chatId = msg.chatId;
        const text = msg.text ?? "";

        const code = text.match(LINK_CODE)?.[0];
        if (code) return this.handleLinkCode(chatId, code, msg.senderName);

        const link = await this.deps.links.getByChat(chatId);
        if (!link) return this.nudgeUnlinked(chatId);

        if (text.startsWith("/")) return this.handleCommand(link, text);

        if (msg.media?.kind === "document") return this.ingestDocument(link, msg, text);

        const parts: ContentPart[] = [];
        if (msg.media?.kind === "image") {
            const mediaType = msg.media.mimetype.split(";")[0];
            if (!IMAGE_TYPES.has(mediaType)) {
                return this.reply(chatId, "That image format isn't supported — try a JPG or PNG.");
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

    private async handleLinkCode(chatId: string, code: string, senderName?: string): Promise<void> {
        const consumed = await this.deps.links.consumeCode(code);
        if (!consumed) {
            return this.reply(chatId, `That code is invalid or has expired. Generate a new one in Owl Bot → **Connect ${this.adapter.label}**.`);
        }
        const existing = await this.deps.links.getByChat(chatId);
        if (existing && existing.userId === consumed.userId) {
            if (consumed.sessionId) await this.deps.links.setActiveSession(chatId, consumed.sessionId);
        } else {
            await this.deps.links.link(chatId, consumed.userId, senderName ?? null, consumed.sessionId);
        }

        if (consumed.sessionId) {
            const session = await this.deps.messageService.getSession(consumed.sessionId, consumed.userId);
            return this.reply(chatId, `✅ Linked. Continuing **${session.title || "your chat"}** here — send your next message.`);
        }
        return this.reply(chatId, `✅ This ${this.adapter.id === "whatsapp" ? "number" : "chat"} is now linked to your Owl Bot account.\n\n${this.help}`);
    }

    private async nudgeUnlinked(chatId: string): Promise<void> {
        const last = this.lastNudge.get(chatId) ?? 0;
        if (Date.now() - last < NUDGE_INTERVAL_MS) return;
        this.lastNudge.set(chatId, Date.now());
        const web = process.env.WEB_APP_URL ? ` (${process.env.WEB_APP_URL})` : "";
        const what = this.adapter.id === "whatsapp" ? "This number isn't" : "This chat isn't";
        await this.reply(
            chatId,
            `👋 Hi! I'm Owl Bot. ${what} linked to an account yet.\n\nOpen Owl Bot on the web${web} → **Connect ${this.adapter.label}**, then send the code here.`
        );
    }

    private async handleCommand(link: ChannelLink, text: string): Promise<void> {
        // "/model@MyBot 2" (Telegram groups style) → "/model 2"
        const [rawCmd, ...rest] = text.trim().split(/\s+/);
        const cmd = rawCmd.toLowerCase().replace(/@\S+$/, "");
        const arg = rest.join(" ").trim();
        const chatId = link.chatId;

        switch (cmd) {
            case "/help":
            case "/start":
                return this.reply(chatId, this.help);

            case "/new": {
                const session = await this.deps.messageService.createSession(link.userId, this.adapter.id as any, `${this.adapter.label} chat`);
                await this.deps.links.setActiveSession(chatId, session.id);
                return this.reply(chatId, "🆕 Started a new chat. What would you like to talk about?");
            }

            case "/docs": {
                const docs = (await this.deps.kb.listDocuments(link.userId)).slice(0, 20);
                if (!docs.length) return this.reply(chatId, "Your knowledge base is empty. Send me a PDF or document to add one.");
                this.lastList.set(chatId, docs.map((d) => d.key));
                const lines = docs.map((d, i) => `${i + 1}. ${d.name}`);
                return this.reply(chatId, `📚 **Your documents**\n${lines.join("\n")}\n\nReply /explain <number> for a detailed walkthrough.`);
            }

            case "/explain":
                return this.explain(link, arg);

            case "/model":
                return this.switchModel(link, arg);

            case "/agents":
                return this.listAgents(link);

            case "/agent":
                return this.useAgent(link, arg);

            case "/unlink":
                await this.deps.links.unlinkChat(chatId);
                return this.reply(chatId, `This ${this.adapter.id === "whatsapp" ? "number" : "chat"} has been unlinked. Connect it again any time from Owl Bot on the web.`);

            default:
                return this.reply(chatId, `I don't know that command.\n\n${this.help}`);
        }
    }

    private async explain(link: ChannelLink, arg: string): Promise<void> {
        const chatId = link.chatId;
        if (!arg) return this.reply(chatId, "Which document? Send /docs to see the list, then /explain <number>.");

        let key: string | undefined;
        const n = Number(arg);
        if (Number.isInteger(n) && n > 0) {
            key = this.lastList.get(chatId)?.[n - 1];
            if (!key) return this.reply(chatId, "I don't have a numbered list for that yet — send /docs first.");
        } else {
            const docs = await this.deps.kb.listDocuments(link.userId);
            key = docs.find((d) => d.name.toLowerCase().includes(arg.toLowerCase()))?.key;
            if (!key) return this.reply(chatId, `No document matching “${arg}”. Send /docs to see the list.`);
        }

        const doc = await this.deps.kb.readDocument(link.userId, key);
        if (!doc) return this.reply(chatId, "That document isn't in your knowledge base anymore.");
        await this.reply(chatId, `📖 Reading **${doc.name}**…${doc.truncated ? " (it's long, so I'll cover the first part)" : ""}`);
        await this.ask(link, buildExplainDocumentParts(doc) as ContentPart[]);
    }

    private async switchModel(link: ChannelLink, arg: string): Promise<void> {
        // The server's models plus the user's own keys.
        const options = this.deps.registry
            ? (await this.deps.registry.listFor(link.userId)).providers.flatMap((p) =>
                p.models.map((m) => ({ provider: p.id, model: m.id, providerLabel: p.label })))
            : [...this.deps.providers.entries()].flatMap(([provider, llm]) =>
                (llm.getModels?.() ?? [llm.getModel()]).map((model) => ({ provider: provider as string, model, providerLabel: PROVIDER_LABELS[provider] ?? provider })));
        const current = await this.pickModel(link);
        const label = (o: { providerLabel: string; model: string }) => `${o.providerLabel} · ${o.model}`;

        if (!arg) {
            const lines = options.map((o, i) => `${i + 1}. ${label(o)}${o.provider === current.provider && o.model === current.model ? "  ✓" : ""}`);
            return this.reply(link.chatId, `🤖 **Model**\n${lines.join("\n")}\n\nReply /model <number> to switch.`);
        }
        const n = Number(arg);
        const choice = Number.isInteger(n) && n > 0
            ? options[n - 1]
            : options.find((o) => label(o).toLowerCase().includes(arg.toLowerCase()));
        if (!choice) return this.reply(link.chatId, "I couldn't find that model. Send /model to see the list.");
        await this.deps.links.setModel(link.chatId, choice.provider, choice.model);
        return this.reply(link.chatId, `Switched to **${label(choice)}**.`);
    }

    private async listAgents(link: ChannelLink): Promise<void> {
        if (!this.deps.agents) return this.reply(link.chatId, `I don't know that command.\n\n${this.help}`);
        const agents = (await this.deps.agents.list(link.userId)).slice(0, 20);
        if (!agents.length) return this.reply(link.chatId, "You don't have any agents yet. Create one in Owl Bot on the web → **Agents**.");
        this.lastAgents.set(link.chatId, agents.map((a) => a.id));
        const lines = agents.map((a, i) => `${i + 1}. ${a.icon ? `${a.icon} ` : ""}${a.name}`);
        return this.reply(link.chatId, `🤖 **Your agents**\n${lines.join("\n")}\n\nReply /agent <number> to start a chat with one. /new goes back to a normal chat.`);
    }

    private async useAgent(link: ChannelLink, arg: string): Promise<void> {
        if (!this.deps.agents) return this.reply(link.chatId, `I don't know that command.\n\n${this.help}`);
        if (!arg) return this.listAgents(link);
        const agents = await this.deps.agents.list(link.userId);
        const n = Number(arg);
        const agent = Number.isInteger(n) && n > 0
            ? agents.find((a) => a.id === this.lastAgents.get(link.chatId)?.[n - 1])
            : agents.find((a) => a.name.toLowerCase().includes(arg.toLowerCase()));
        if (!agent) return this.reply(link.chatId, "I couldn't find that agent. Send /agents to see the list.");
        const sessionId = await this.deps.agents.startChat(link.userId, agent.id, this.adapter.id);
        await this.deps.links.setActiveSession(link.chatId, sessionId);
        link.activeSessionId = sessionId;
        return this.reply(link.chatId, `${agent.icon ?? "🤖"} You're now chatting with **${agent.name}**. Send your message. (/new for a normal chat)`);
    }

    // The chat's saved model choice, resolved (for the ✓ in /model).
    private async pickModel(link: ChannelLink): Promise<{ provider: string; model: string }> {
        if (this.deps.registry) {
            const r = await this.deps.registry.resolve(link.userId, link.provider, link.model);
            return { provider: r.provider, model: r.model };
        }
        const preferred = link.provider as LLMProvider | null;
        const provider = preferred && this.deps.providers.has(preferred) ? preferred : this.deps.defaultProvider;
        const llm = this.deps.providers.get(provider)!;
        const models = llm.getModels?.() ?? [llm.getModel()];
        return { provider, model: link.model && models.includes(link.model) ? link.model : llm.getModel() };
    }

    private async ingestDocument(link: ChannelLink, msg: InboundMessage, caption: string): Promise<void> {
        const media = msg.media!;
        const name = (media.fileName ?? `${this.adapter.id}-${Date.now()}`).replace(/[\\/]/g, "_");
        await this.reply(link.chatId, `⏳ Adding **${name}** to your knowledge base…`);

        const outcome = await this.deps.kb.ingest(
            { buffer: media.buffer, originalname: name, mimetype: media.mimetype },
            `${link.userId}/`
        );
        if (outcome.status === "failed") {
            return this.reply(link.chatId, `❌ Couldn't add **${name}**: ${outcome.error}`);
        }
        if (!outcome.sections) {
            return this.reply(link.chatId, `Saved **${name}**, but I couldn't read any text from it, so it can't be searched.`);
        }
        this.lastList.set(link.chatId, [`${link.userId}/${name}`]);
        await this.reply(
            link.chatId,
            `✅ Added **${name}** (${outcome.sections} section${outcome.sections === 1 ? "" : "s"}). Ask me about it, or reply /explain 1 for a walkthrough.`
        );
        if (caption) await this.ask(link, [{ type: "text", text: caption }]);
    }

    // Runs one user turn through the runtime and sends the reply.
    private async ask(link: ChannelLink, parts: ContentPart[]): Promise<void> {
        const chatId = link.chatId;
        const sessionId = await this.ensureSession(link);
        const message: LLMMessage = { type: "message", role: "user", content: parts };
        const adapter = this.deps.adapter;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REPLY_TIMEOUT_MS);
        const typing = setInterval(() => void adapter.setTyping?.(chatId, true)?.catch(() => {}), TYPING_REFRESH_MS);
        await adapter.setTyping?.(chatId, true).catch(() => {});

        let reply;
        try {
            // Same runtime as the web app: the chat's agent (if any), the
            // chat's chosen model otherwise, one turn at a time per chat.
            reply = await this.runtime.runToText({
                channel: adapter.id as RunChannel,
                userId: link.userId,
                sessionId,
                input: message,
                provider: link.provider,
                model: link.model,
            }, controller.signal);
        } finally {
            clearTimeout(timeout);
            clearInterval(typing);
            await adapter.setTyping?.(chatId, false).catch(() => {});
        }
        const { text, sources } = reply;
        const error = reply.error ?? (reply.cancelled ? "That took too long, so I stopped. Try a shorter question." : null);

        if (!text.trim()) {
            return this.reply(chatId, `⚠️ ${error ?? "I couldn't come up with a reply. Please try again."}`);
        }

        let body = text.trim();
        if (sources.length) {
            this.lastList.set(chatId, sources);
            const list = sources.map((s, i) => `${i + 1}. ${s.split("/").pop() || s}`).join("\n");
            body += `\n\n📄 **Sources**\n${list}\nReply /explain <number> for a detailed walkthrough.`;
        }
        if (error) body += `\n\n⚠️ ${error}`;
        await this.reply(chatId, body);
        await this.deliverFiles(link, reply.files ?? []);
    }

    // Generated Word/Excel files go to the chat as attachments; when the app
    // can't take files, the user is pointed to the web app instead.
    private async deliverFiles(link: ChannelLink, files: NonNullable<Awaited<ReturnType<AgentRuntime["runToText"]>>["files"]>) {
        for (const f of files.slice(0, 5)) {
            try {
                if (!this.deps.files || !this.deps.adapter.sendFile) throw new Error("files not supported here");
                const file = await this.deps.files(link.userId, f.id);
                await this.deps.adapter.sendFile(link.chatId, { ...file, caption: f.filename });
            } catch (err) {
                console.warn(`[${this.adapter.id}-bridge] couldn't send ${f.filename}:`, err instanceof Error ? err.message : err);
                await this.reply(link.chatId, `📎 **${f.filename}** is ready — download it from this chat in Owl Bot on the web.`);
            }
        }
    }

    private async ensureSession(link: ChannelLink): Promise<string> {
        if (link.activeSessionId && (await this.deps.messageService.isSessionValid(link.activeSessionId, link.userId))) {
            return link.activeSessionId;
        }
        const session = await this.deps.messageService.createSession(link.userId, this.adapter.id as any, `${this.adapter.label} chat`);
        await this.deps.links.setActiveSession(link.chatId, session.id);
        link.activeSessionId = session.id;
        return session.id;
    }

    // Markdown → the app's formatting, split into message-sized pieces.
    protected async reply(chatId: string, markdown: string): Promise<void> {
        for (const piece of this.deps.adapter.render(markdown)) {
            await this.deps.adapter.send(chatId, piece);
            metrics.channelMessages.inc({ channel: this.adapter.id, direction: "out" });
        }
    }
}
