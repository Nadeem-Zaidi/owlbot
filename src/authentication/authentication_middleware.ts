import { NextFunction, Request, Response } from "express";
import { firebaseAdmin } from "./fire_admin";
import { DecodedIdToken } from "firebase-admin/auth";
import chalk from "chalk";
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

export const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Not a valid token" });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "Token missing" });
    }


    let decoded: DecodedIdToken;
    try {
        decoded = await firebaseAdmin.auth().verifyIdToken(token);
    } catch (error) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
    // Sign-up isn't finished until a phone number is verified; enforce it here
    // too, not just in the web app. Set REQUIRE_VERIFIED_PHONE=false to allow
    // accounts without one.
    if (REQUIRE_VERIFIED_PHONE && !decoded.phone_number) {
        return res.status(403).json({ error: "Verify your phone number to finish signing up", message: "Verify your phone number to finish signing up" });
    }
    req.user = decoded;
    req.prefix=`nadeem-bucket-9891/${decoded.uid}/`
    next();
};

const REQUIRE_VERIFIED_PHONE = process.env.REQUIRE_VERIFIED_PHONE !== "false";

// Same rules as verifyToken, for the live-events WebSocket (no Express request).
export async function verifySocketToken(token: string): Promise<{ uid: string }> {
    const decoded = await firebaseAdmin.auth().verifyIdToken(token);
    if (REQUIRE_VERIFIED_PHONE && !decoded.phone_number) throw new Error("phone not verified");
    return { uid: decoded.uid };
}