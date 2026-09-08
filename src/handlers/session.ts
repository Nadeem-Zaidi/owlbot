import { Request, Response } from "express";
import { SessionRepository } from "../repository/sessiopn_repository";

export const getSessions = async (req: Request, res: Response, session: SessionRepository) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const s = await session.getUserSessions(userId);
    res.json(s);
  } catch (error) {
    console.error("getSession error:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
};

export const getSession = async (req: Request<{ id: string }>, res: Response, session: SessionRepository) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const sessionId = req.params.id;
    if (!sessionId) return res.status(401).json({ error: "Session id is null or undefined" })

    const s = await session.getSession(sessionId);
    res.json(s);
  } catch (error) {
    console.error("getSession error:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }


}

export const newSession = async (req: Request, res: Response, session: SessionRepository) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const s = await session.createSession(userId);
    res.status(201).json(s);  // ← was returning `session` (the repo), now correctly returns `s`
  } catch (error) {
    console.error("newSession error:", error);
    res.status(500).json({ error: "Failed to create session" });
  }
};

export const getMessages = async (req: Request<{ sessionId: string }>, res: Response, session: SessionRepository) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Session ID required" });

    const messages = await session.getSessionMessages(sessionId, userId);
    if (!messages) return res.status(403).json({ error: "Not found" });

    res.json(messages);
  } catch (error) {
    console.error("getMessages error:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
};

export const deleteSession = async (req: Request<{ id: string }>, res: Response, session: SessionRepository) => {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const sessionId = req.params.id;
    if (!sessionId) return res.status(400).json({ error: "Session ID required" });

    await session.deleteSession(sessionId, userId);
    res.json({ ok: true });
  } catch (error) {
    console.error("deleteSession error:", error);
    res.status(500).json({ error: "Failed to delete session" });
  }
};