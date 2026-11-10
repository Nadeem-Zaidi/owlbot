import { NextFunction, Request, Response, Router } from "express";
import { firebaseAdmin } from "../authentication/fire_admin";
import { forgetAccount } from "../authentication/authentication_middleware";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        console.error("[auth] request failed:", err);
        if (!res.headersSent) res.status(500).json({ message: "Something went wrong" });
    });
};

// /api/auth — the signed-in user's sessions (behind Firebase auth).
export function createAuthRouter(): Router {
    const r = Router();
    // Signs the user out on every device: their refresh tokens stop working,
    // and verifyToken refuses ID tokens issued before now.
    r.post("/sign-out-everywhere", h(async (req, res) => {
        const uid = req.user!.uid;
        await firebaseAdmin.auth().revokeRefreshTokens(uid);
        forgetAccount(uid);
        res.json({ ok: true });
    }));
    return r;
}
