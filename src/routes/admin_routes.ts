import { NextFunction, Request, Response, Router } from "express";
import { isOwner, ownerEmails } from "../service/agents/owner";
import { SettingsService, TelegramVerifier } from "../service/settings_service";
import { WhatsAppManager } from "../service/whatsapp_manager";
import { TelegramManager } from "../service/telegram_manager";
import { ChannelControl } from "../channels/core/channel_control";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const status = Number(err?.status ?? err?.statusCode) || 500;
        if (status >= 500) console.error("[admin] request failed:", err);
        if (!res.headersSent) res.status(status).json({ message: status >= 500 ? "Something went wrong" : err?.message ?? "Request failed" });
    });
};

// Owners are listed in OWNER_EMAILS (.env) on purpose: it's the root of trust,
// so it can't be changed from the web app it protects.
const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    if (!isOwner(req.user?.email)) return res.status(403).json({ message: "Only the app owner can change server settings." });
    next();
};

// /api/admin — server settings for the owner (behind Firebase auth).
export function createAdminRouter(
    settings: SettingsService,
    whatsapp: WhatsAppManager,
    telegram?: { manager: TelegramManager; verify: TelegramVerifier },
    // Live state of channels running in another process (ROLE=jobs).
    controls?: { whatsapp?: ChannelControl; telegram?: ChannelControl },
): Router {
    const r = Router();

    // Lets the web app decide whether to show "Server settings".
    r.get("/me", h(async (req, res) => res.json({ isOwner: isOwner(req.user?.email), ownersConfigured: ownerEmails().length > 0 })));

    const whatsappView = async () => {
        const s = await settings.whatsapp(true);
        const runtime = await liveStatus(whatsapp.status(), controls?.whatsapp);
        return {
            settings: { enabled: s.enabled, selfChat: s.selfChat, adminEmails: s.adminEmails },
            updatedAt: s.updatedAt,
            updatedBy: s.updatedBy,
            runtime: {
                // false when another server (the "jobs" instance) runs WhatsApp;
                // it picks up changes within ~15 seconds.
                hostedHere: runtime.hosted,
                running: runtime.running,
                state: runtime.state,
                botNumber: runtime.state === "connected" ? (runtime as any).botNumber : undefined,
            },
        };
    };

    r.get("/settings/whatsapp", requireOwner, h(async (_req, res) => res.json(await whatsappView())));

    r.put("/settings/whatsapp", requireOwner, h(async (req, res) => {
        const next = await settings.saveWhatsApp(req.body, req.user!.email ?? req.user!.sub);
        await whatsapp.apply(next);   // this server applies it right away
        res.json(await whatsappView());
    }));

    // ── Telegram bot ──
    if (telegram) {
        const telegramView = async () => {
            const runtime = await liveStatus(telegram.manager.status(), controls?.telegram);
            return {
                settings: await settings.telegramView(),
                runtime: { hostedHere: runtime.hosted, running: runtime.running, state: runtime.state },
            };
        };
        r.get("/settings/telegram", requireOwner, h(async (_req, res) => res.json(await telegramView())));
        // { enabled?, botToken? } — a new token is checked with Telegram first.
        r.put("/settings/telegram", requireOwner, h(async (req, res) => {
            const next = await settings.saveTelegram(req.body, req.user!.email ?? req.user!.sub, telegram.verify);
            await telegram.manager.apply(next);
            res.json(await telegramView());
        }));
    }

    return r;
}

// This process's view, or — when the channel runs elsewhere — its snapshot.
async function liveStatus<T extends { hosted: boolean; running: boolean; state: string }>(local: T, control?: ChannelControl): Promise<T & { botNumber?: string }> {
    if (local.running || !control) return local;
    const snap = await control.status().catch(() => null);
    return snap ? { ...local, running: true, state: snap.state, botNumber: snap.botNumber } : local;
}
