import { NextFunction, Request, Response, Router } from "express";
import { ChannelLinkRepository } from "../repository/channel_link_repository";
import { MessageService } from "../service/message_service";
import { SettingsService } from "../service/settings_service";
import { ChannelControl } from "../channels/core/channel_control";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const status = Number(err?.status ?? err?.statusCode) || 500;
        if (status >= 500) console.error("[telegram] request failed:", err);
        if (!res.headersSent) res.status(status).json({ message: status >= 500 ? "Something went wrong" : err?.message ?? "Request failed" });
    });
};

// /api/telegram — link your Telegram, continue a chat there, unlink.
// Behind Firebase auth; every call is scoped to the signed-in user.
//
// The bot runs on one server; this one may not be it, so the bot's username
// comes from the saved settings rather than the local process.
export function createTelegramRouter(messages: MessageService, links: ChannelLinkRepository, control: ChannelControl, settings: SettingsService): Router {
    const r = Router();
    const uid = (req: Request) => req.user!.sub;

    const bot = async () => {
        const [s, live] = await Promise.all([settings.telegram(), control.status()]);
        return {
            enabled: s.enabled && !!s.botToken,
            username: s.botUsername,
            state: live?.state,
        };
    };

    r.get("/status", h(async (req, res) => {
        const [b, link] = await Promise.all([bot(), links.getByUser(uid(req))]);
        res.json({
            enabled: b.enabled,
            botUsername: b.username,
            botState: b.state,
            link: link ? { displayName: link.displayName, linkedAt: link.linkedAt } : null,
        });
    }));

    // One-time code; the deep link opens the bot with it pre-filled.
    r.post("/link_code", h(async (req, res) => {
        const b = await bot();
        if (!b.enabled || !b.username) return res.status(503).json({ message: "Telegram isn't set up on this server." });
        const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : null;
        if (sessionId && !(await messages.isSessionValid(sessionId, uid(req)))) return res.status(404).json({ message: "Chat not found." });
        const { code, expiresAt } = await links.createCode(uid(req), sessionId);
        res.json({ code, expiresAt, botUsername: b.username, deepLink: `https://t.me/${b.username}?start=${code}` });
    }));

    // Move a web chat to Telegram for an already-linked account.
    r.post("/continue", h(async (req, res) => {
        if (!(await control.status())) return res.status(503).json({ message: "Telegram isn't running right now." });
        const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
        if (!sessionId || !(await messages.isSessionValid(sessionId, uid(req)))) return res.status(404).json({ message: "Chat not found." });
        if (!(await control.continueSession(uid(req), sessionId))) return res.status(409).json({ needsLink: true, message: "Link your Telegram first." });
        res.json({ ok: true });
    }));

    r.delete("/link", h(async (req, res) => {
        res.json({ unlinked: await links.unlinkUser(uid(req)) });
    }));

    return r;
}
