import { NextFunction, Request, Response, Router } from "express";
import { MemoryService } from "../core/memory";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const status = Number(err?.status ?? err?.statusCode) || 500;
        if (status >= 500) console.error("[memory] request failed:", err);
        if (!res.headersSent) res.status(status).json({ message: status >= 500 ? "Something went wrong" : err?.message ?? "Request failed" });
    });
};

// /api/memory — what the assistant remembers about the signed-in user.
// Behind Firebase auth; every call is scoped to that user.
export function createMemoryRouter(memory: MemoryService): Router {
    const r = Router();
    const uid = (req: Request) => req.user!.sub;
    r.get("/", h(async (req, res) => res.json(await memory.overview(uid(req)))));
    r.put("/settings", h(async (req, res) => res.json(await memory.setMode(uid(req), req.body?.mode))));
    r.post("/", h(async (req, res) => res.status(201).json(await memory.add(uid(req), req.body?.content))));
    // { content } to edit, { status: "active" } to approve a suggestion.
    r.put("/:id", h(async (req, res) => res.json(await memory.edit(uid(req), String(req.params.id), req.body ?? {}))));
    r.delete("/:id", h(async (req, res) => {
        await memory.remove(uid(req), String(req.params.id));
        res.status(204).send();
    }));
    // Forget everything.
    r.delete("/", h(async (req, res) => res.json({ deleted: await memory.clear(uid(req)) })));
    return r;
}
