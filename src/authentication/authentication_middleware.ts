import { NextFunction, Request, Response } from "express";
import { firebaseAdmin } from "./fire_admin";
import { DecodedIdToken } from "firebase-admin/auth";
import { SessionRepository } from "../repository/sessiopn_repository";

declare global {
    namespace Express {
        interface Request {
            user?: DecodedIdToken;
            sessionId?: string;
            prefix?:string;
        }
    }
}

export const createSession = (sessionRepo: SessionRepository) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Not a valid token" });
        }

        // req.user should already be set by verifyToken middleware
        const userId = req.user?.uid;
        if (!userId) {
            return res.status(401).json({ error: "User not authenticated" });
        }
        try {
            const { sessionId } = req.body;
            const session = await sessionRepo.getOrCreateSession(userId, sessionId);
            req.sessionId = session.id;
            next();
        } catch (error) {
            next(error);
        }

    }
}

// Sign-up isn't finished until a phone number is verified. Set
// REQUIRE_VERIFIED_PHONE=false to allow accounts without one.
const REQUIRE_VERIFIED_PHONE = process.env.REQUIRE_VERIFIED_PHONE !== "false";

// How people may sign in: Google (with the phone linked afterwards), or an
// older phone-only account. Email/password, anonymous and custom tokens are
// refused, so nobody can make an account with an email they don't own.
const SIGN_IN_PROVIDERS = new Set((process.env.AUTH_PROVIDERS ?? "google.com,phone").split(",").map((p) => p.trim()).filter(Boolean));

// Revoked sessions ("sign out everywhere") and disabled accounts are checked
// against Firebase, cached briefly so every request doesn't wait on it.
const ACCOUNT_CACHE_MS = 60_000;
const accounts = new Map<string, { validSince: number; disabled: boolean; at: number }>();

export class AuthError extends Error {
    constructor(public status: 401 | 403 | 503, public code: string, message: string) {
        super(message);
    }
}

async function accountState(uid: string) {
    const cached = accounts.get(uid);
    if (cached && Date.now() - cached.at < ACCOUNT_CACHE_MS) return cached;
    const user = await firebaseAdmin.auth().getUser(uid);
    const state = {
        validSince: user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : 0,
        disabled: user.disabled,
        at: Date.now(),
    };
    if (accounts.size > 10_000) accounts.clear();
    accounts.set(uid, state);
    return state;
}

// Forget the cached state, e.g. right after revoking a user's sessions.
export const forgetAccount = (uid: string) => accounts.delete(uid);

// Every rule a signed-in request must pass. Throws AuthError.
export async function checkIdToken(token: string): Promise<DecodedIdToken> {
    let decoded: DecodedIdToken;
    try {
        decoded = await firebaseAdmin.auth().verifyIdToken(token);
    } catch {
        throw new AuthError(401, "token_invalid", "Your session has expired. Please sign in again.");
    }
    if (!SIGN_IN_PROVIDERS.has(decoded.firebase?.sign_in_provider)) {
        throw new AuthError(403, "provider_not_allowed", "Please sign in with Google.");
    }
    // An email we show and trust (owner checks, teammates) must be verified.
    if (decoded.email && decoded.email_verified !== true) {
        throw new AuthError(403, "email_unverified", "Please sign in with Google.");
    }
    let account;
    try {
        account = await accountState(decoded.uid);
    } catch (err: any) {
        // Deleted in Firebase: the session is over. Anything else (a revoked
        // admin key, Firebase unreachable) is a server problem: refuse rather
        // than guess, and say so loudly in the log.
        if (err?.code === "auth/user-not-found") throw new AuthError(401, "token_invalid", "Your session has expired. Please sign in again.");
        console.error(`[auth] couldn't check account ${decoded.uid} with Firebase (${err?.code ?? "error"}): ${String(err?.message ?? err).split("\n")[0]}`);
        throw new AuthError(503, "auth_unavailable", "Sign-in is temporarily unavailable. Please try again in a minute.");
    }
    if (account.disabled) throw new AuthError(403, "account_disabled", "This account has been disabled.");
    // Same rule as checkRevoked: tokens issued before the last "sign out everywhere".
    if (decoded.iat * 1000 < account.validSince) throw new AuthError(401, "token_revoked", "You were signed out. Please sign in again.");
    if (REQUIRE_VERIFIED_PHONE && !decoded.phone_number) {
        throw new AuthError(403, "phone_required", "Verify your phone number to finish signing up");
    }
    return decoded;
}

export const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) {
        return res.status(401).json({ code: "token_missing", error: "Not signed in", message: "Please sign in." });
    }
    try {
        req.user = await checkIdToken(token);
    } catch (err) {
        if (err instanceof AuthError) return res.status(err.status).json({ code: err.code, error: err.message, message: err.message });
        return next(err);
    }
    req.prefix = `nadeem-bucket-9891/${req.user.uid}/`;
    next();
};

// Same rules as verifyToken, for the live-events WebSocket (no Express request).
export async function verifySocketToken(token: string): Promise<{ uid: string }> {
    const decoded = await checkIdToken(token);
    return { uid: decoded.uid };
}
