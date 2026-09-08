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


    try {
        const decoded = await firebaseAdmin.auth().verifyIdToken(token);
        req.user = decoded;
        req.prefix=`nadeem-bucket-9891/${decoded.uid}/`
        next();
    } catch (error) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
};