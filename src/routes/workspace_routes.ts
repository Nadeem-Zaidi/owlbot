import { NextFunction, Request, Response, Router } from "express";
import { workspaceJoinRateLimit } from "../infra/rate_limit";
import { WorkspaceService, profileFrom } from "../core/workspaces/workspace_service";

// /api/workspaces — team workspaces, members, invite links, audit log.
// Every handler checks the caller's role in WorkspaceService.

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const status = err?.status ?? 500;
        if (status >= 500) console.error("[workspaces] request failed:", err);
        if (!res.headersSent) res.status(status).json({ message: status >= 500 ? "Something went wrong" : err?.message ?? "Request failed" });
    });
};

export function createWorkspaceRouter(service: WorkspaceService, onDeleted?: (workspaceId: string) => Promise<void>): Router {
    const r = Router();
    const uid = (req: Request) => req.user!.uid;
    const p = (req: Request, k: string) => String(req.params[k]);
    const profile = (req: Request) => profileFrom(req.user as any);

    // Joining is the one action a stranger can try with a guessed token.
    const joinLimit = workspaceJoinRateLimit();

    r.get("/", h(async (req, res) => res.json({ workspaces: await service.list(uid(req), profile(req)) })));
    r.post("/", h(async (req, res) => res.status(201).json(await service.create(uid(req), profile(req), req.body))));

    // Invites by token (before the :id routes).
    r.get("/invites/:token", joinLimit, h(async (req, res) => res.json(await service.previewInvite(uid(req), p(req, "token")))));
    r.post("/invites/:token/accept", joinLimit, h(async (req, res) => res.json(await service.acceptInvite(uid(req), profile(req), p(req, "token")))));

    r.get("/:id", h(async (req, res) => res.json(await service.detail(uid(req), p(req, "id")))));
    r.patch("/:id", h(async (req, res) => res.json(await service.rename(uid(req), p(req, "id"), req.body))));
    r.delete("/:id", h(async (req, res) => {
        await service.delete(uid(req), p(req, "id"), req.body?.confirmName, onDeleted);
        res.status(204).send();
    }));

    r.patch("/:id/members/:userId", h(async (req, res) => {
        await service.setRole(uid(req), p(req, "id"), p(req, "userId"), req.body);
        res.json(await service.detail(uid(req), p(req, "id")));
    }));
    r.delete("/:id/members/:userId", h(async (req, res) => {
        await service.removeMember(uid(req), p(req, "id"), p(req, "userId"));
        res.status(204).send();
    }));
    r.post("/:id/transfer", h(async (req, res) => {
        await service.transfer(uid(req), p(req, "id"), req.body);
        res.json(await service.detail(uid(req), p(req, "id")));
    }));

    r.post("/:id/invites", h(async (req, res) => res.status(201).json(await service.createInvite(uid(req), p(req, "id"), req.body))));
    r.delete("/:id/invites/:inviteId", h(async (req, res) => {
        await service.revokeInvite(uid(req), p(req, "id"), p(req, "inviteId"));
        res.status(204).send();
    }));

    r.get("/:id/audit", h(async (req, res) => res.json({ events: await service.auditLog(uid(req), p(req, "id"), req.query.before) })));
    return r;
}
