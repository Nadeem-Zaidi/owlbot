import { WhatsAppRepository } from "../repository/whatsapp_repository";
import { MessageService } from "../service/message_service";
import { SettingsService } from "../service/settings_service";
import { WhatsAppManager } from "../service/whatsapp_manager";
import { BaseRouter } from "./base_router";

const waLink = (number: string, text?: string) =>
    `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ""}`;

// Web side of the WhatsApp integration: link a number, continue a chat on
// the phone, unlink. Mounted at /api/whatsapp (behind the same Firebase auth
// as everything else). The bridge exists only while WhatsApp is turned on in
// Server settings. Who may see the pairing QR (scanning it turns the
// scanner's WhatsApp account into the bot) is also a server setting.
export class WhatsAppRoutes extends BaseRouter<MessageService> {
    constructor(
        messageService: MessageService,
        private repo: WhatsAppRepository,
        private manager: WhatsAppManager,
        private settings: SettingsService,
    ) {
        super("/whatsapp", messageService);
    }

    private get bridge() {
        return this.manager.bridge;
    }

    private canPair(email?: string) {
        return this.settings.canPairWhatsApp(email);
    }

    registerRouter(): void {

        this.router.get("/status", this.asyncHandler(async (req, res) => {
            const bridge = this.bridge;
            const bot = bridge?.status();
            const link = bridge ? await this.repo.getByUser(req.user!.sub) : null;
            const pairAllowed = !!bridge && await this.canPair(req.user!.email);
            return res.status(200).json({
                enabled: !!bridge,
                botConnected: bot?.state === "connected",
                botNumber: bot?.state === "connected" ? bot.botNumber : undefined,
                botState: bot?.state,
                canPair: pairAllowed,
                // The away message only applies when the bot runs on your own number.
                awayAvailable: !!bridge && bridge.selfChatMode() && pairAllowed,
                // Raw QR text; the browser draws it. Rotates every ~20s.
                pairingQr: pairAllowed && bot?.state === "awaiting_qr" ? bot.qr : undefined,
                link: link
                    ? {
                        number: link.jid.split("@")[0].split(":")[0],
                        displayName: link.display_name,
                        linkedAt: link.linked_at,
                    }
                    : null,
            });
        }));

        // Away message (self-chat mode): an automatic reply to people who write
        // to your number while you're away. Only whoever may pair the bot can see
        // or change it, since it speaks for that number.
        this.router.get("/away", this.asyncHandler(async (req, res) => {
            const bridge = this.bridge;
            if (!bridge || !(await this.canPair(req.user!.email))) return res.status(403).json({ message: "Only the bot's owner can change the away message." });
            const [away, recipients] = await Promise.all([this.repo.getAway(), this.repo.awayRecipients()]);
            return res.status(200).json({
                available: bridge.selfChatMode(),
                ...away,
                recipients: {
                    total: recipients.total,
                    recent: recipients.recent.map((r) => ({ number: r.jid.endsWith("@lid") ? null : r.jid.split("@")[0], name: r.name, repliedAt: r.replied_at, count: r.reply_count })),
                },
            });
        }));

        this.router.put("/away", this.asyncHandler(async (req, res) => {
            const bridge = this.bridge;
            if (!bridge || !(await this.canPair(req.user!.email))) return res.status(403).json({ message: "Only the bot's owner can change the away message." });
            if (!bridge.selfChatMode()) return res.status(400).json({ message: "The away message works when the bot runs on your own number — turn on self-chat mode in Server settings." });
            const b = req.body ?? {};
            const enabled = b.enabled === true;
            const message = typeof b.message === "string" ? b.message.trim() : "";
            if (message.length > 1000) return res.status(400).json({ message: "Keep the away message under 1000 characters." });
            if (enabled && !message) return res.status(400).json({ message: "Write the away message first." });
            const cooldown = Math.round(Number(b.cooldown_minutes ?? 720));
            if (!Number.isFinite(cooldown) || cooldown < 30 || cooldown > 7 * 24 * 60) return res.status(400).json({ message: "Repeat interval must be between 30 minutes and 7 days." });
            let until: Date | null = null;
            if (b.until) {
                until = new Date(b.until);
                if (Number.isNaN(until.getTime())) return res.status(400).json({ message: "Invalid end time." });
                if (enabled && until.getTime() <= Date.now()) return res.status(400).json({ message: "The end time is already in the past." });
            }
            const saved = await this.repo.saveAway({ enabled, message, cooldown_minutes: cooldown, until }, req.user!.sub);
            return res.status(200).json({ available: true, ...saved });
        }));

        // One-time code for linking this number (optionally continuing a chat).
        this.router.post("/link_code", this.asyncHandler(async (req, res) => {
            const bridge = this.bridge;
            const bot = bridge?.status();
            if (!bridge || bot?.state !== "connected" || !bot.botNumber) {
                return res.status(503).json({ message: "WhatsApp isn't connected on the server right now." });
            }
            const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : null;
            if (sessionId && !(await this.service.isSessionValid(sessionId, req.user!.sub))) {
                return res.status(404).json({ message: "Chat not found." });
            }
            const { code, expiresAt } = await this.repo.createCode(req.user!.sub, sessionId);
            return res.status(200).json({
                code,
                expiresAt,
                botNumber: bot.botNumber,
                waLink: waLink(bot.botNumber, `link ${code}`),
            });
        }));

        // Move a web chat to WhatsApp for an already-linked number.
        this.router.post("/continue", this.asyncHandler(async (req, res) => {
            const bridge = this.bridge;
            const bot = bridge?.status();
            if (!bridge || bot?.state !== "connected" || !bot.botNumber) {
                return res.status(503).json({ message: "WhatsApp isn't connected on the server right now." });
            }
            const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
            if (!sessionId || !(await this.service.isSessionValid(sessionId, req.user!.sub))) {
                return res.status(404).json({ message: "Chat not found." });
            }
            const continued = await bridge.continueSession(req.user!.sub, sessionId);
            if (!continued) return res.status(409).json({ needsLink: true, message: "Link your WhatsApp number first." });
            return res.status(200).json({ waLink: waLink(bot.botNumber) });
        }));

        // Starts pairing the bot's own number (shows a QR in the web app).
        this.router.post("/bot/pair", this.asyncHandler(async (req, res) => {
            const bridge = this.bridge;
            if (!bridge) return res.status(404).json({ message: "WhatsApp is turned off — an owner can turn it on in Server settings." });
            if (!(await this.canPair(req.user!.email))) return res.status(403).json({ message: "Only an admin can pair the bot's number." });
            await bridge.pairBot();
            return res.status(202).json({ state: bridge.status().state });
        }));

        this.router.delete("/link", this.asyncHandler(async (req, res) => {
            await this.repo.unlinkUser(req.user!.sub);
            return res.status(204).send();
        }));
    }
}
