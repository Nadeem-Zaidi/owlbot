import { NextFunction, Request, Response, Router } from "express";
import { isOwner, ownerEmails } from "../service/agents/owner";
import { SettingsService } from "../service/settings_service";
import { WhatsAppManager } from "../service/whatsapp_manager";

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
export function createAdminRouter(settings: SettingsService, whatsapp: WhatsAppManager): Router {
    const r = Router();

    // Lets the web app decide whether to show "Server settings".
    r.get("/me", h(async (req, res) => res.json({ isOwner: isOwner(req.user?.email), ownersConfigured: ownerEmails().length > 0 })));

    const whatsappView = async () => {
        const s = await settings.whatsapp(true);
        const runtime = whatsapp.status();
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

    return r;
}
