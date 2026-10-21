import { NextFunction, Request, Response } from "express";
import { Membership, WorkspaceService, kbScopeFor } from "./workspace_service";

// Which workspace a request acts in. The web app sends the chosen one as
// "X-Workspace-Id"; no header (or "personal") means the user's own space,
// so older clients, the desktop app and WhatsApp keep working unchanged.

declare global {
    namespace Express {
        interface Request {
            // null = personal space.
            workspace?: Membership | null;
        }
    }
}

let service: WorkspaceService | null = null;
export const setWorkspaceService = (s: WorkspaceService) => { service = s; };

export function workspaceContext() {
    return async (req: Request, res: Response, next: NextFunction) => {
        req.workspace = null;
        const raw = req.headers["x-workspace-id"];
        const id = Array.isArray(raw) ? raw[0] : raw;
        if (!id || id === "personal" || !service || !req.user?.uid) return next();
        try {
            const m = await service.membership(req.user.uid, id);
            // A stale choice (removed, or the workspace was deleted): the app
            // switches back to the personal space when it sees this code.
            if (!m) return res.status(403).json({ code: "workspace_forbidden", message: "You're no longer a member of that workspace" });
            req.workspace = m;
            next();
        } catch (err) {
            next(err);
        }
    };
}

// The knowledge-base folder a request reads and writes: the team's shared
// one in a workspace, the user's own otherwise.
export const kbScope = (req: Request) => kbScopeFor(req.workspace?.id, req.user!.uid);
