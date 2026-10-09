import { AwayDecision, AwayRequest, IChannel } from "../interfaces/ichannel";
import { ILLM } from "../interfaces/illm";
import { LLMProvider } from "../llms/llm_factory";
import { WhatsAppRepository } from "../repository/whatsapp_repository";
import { KnowledgeBase } from "./knowledge_base";
import { MessageService } from "./message_service";
import { ModelRegistry } from "./model_registry";
import { AgentRuntime } from "../core/runtime";
import { ChatBridge } from "../channels/core/chat_bridge";
import { AgentDirectory } from "../channels/core/chat_adapter";
import { WhatsAppAdapter, whatsappLinkStore } from "../channels/whatsapp_adapter";

export type { AgentDirectory } from "../channels/core/chat_adapter";

type BridgeDeps = {
    channel: IChannel;
    repo: WhatsAppRepository;
    messageService: MessageService;
    providers: Map<LLMProvider, ILLM>;
    defaultProvider: LLMProvider;
    kb: KnowledgeBase;
    // Server providers + the user's own keys (BYOK).
    registry?: ModelRegistry;
    // Runs each turn — the same runtime as the web app.
    runtime?: AgentRuntime;
    agents?: AgentDirectory;
    files?: (userId: string, fileId: string) => Promise<{ buffer: Buffer; filename: string; mime: string }>;
};

// WhatsApp on top of the generic ChatBridge (linking, commands, documents,
// answering), plus what only WhatsApp has: the away message when the bot
// runs on your own number, and pairing the bot's number by QR.
export class WhatsAppBridge extends ChatBridge {
    private channel: IChannel;
    private repo: WhatsAppRepository;

    constructor(deps: BridgeDeps) {
        super({
            adapter: new WhatsAppAdapter(deps.channel),
            links: whatsappLinkStore(deps.repo),
            messageService: deps.messageService,
            providers: deps.providers,
            defaultProvider: deps.defaultProvider,
            kb: deps.kb,
            registry: deps.registry,
            runtime: deps.runtime,
            agents: deps.agents,
            files: deps.files,
        });
        this.channel = deps.channel;
        this.repo = deps.repo;
    }

    start(): void {
        super.start();
        this.channel.onAway?.((req) => this.awayReply(req));
    }

    selfChatMode(): boolean {
        return this.channel.isSelfChatMode?.() ?? false;
    }

    // The channel's own status shape (state, botNumber, qr) for the routes.
    status() {
        return this.channel.getStatus?.() ?? { state: "disconnected" as const };
    }

    async pairBot(): Promise<void> {
        await this.channel.pair?.();
    }

    // Away message for someone writing to your number: once per person per
    // cooldown, while it's on and before its end time.
    async awayReply(req: AwayRequest): Promise<AwayDecision> {
        const away = await this.repo.getAway();
        if (!away.enabled || !away.message.trim()) return null;
        if (away.until && new Date(away.until).getTime() <= Date.now()) {
            console.log("[whatsapp] away message ended (its end time passed) — turned off");
            await this.repo.disableAway();
            return null;
        }
        if (!(await this.repo.claimAwayReply(req.jid, req.name ?? null, away.cooldown_minutes))) {
            const hours = Math.round(away.cooldown_minutes / 6) / 10;
            console.log(`[whatsapp] away message skipped for ${maskJid(req.jid)}: already sent in the last ${hours} h (repeat interval)`);
            return null;
        }
        return { text: renderAway(away.message, req.name), failed: () => this.repo.releaseAwayReply(req.jid) };
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
