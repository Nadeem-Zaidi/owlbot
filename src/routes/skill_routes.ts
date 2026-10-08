import { NextFunction, Request, Response, Router } from "express";
import { SkillService } from "../core/skills";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const status = Number(err?.status ?? err?.statusCode) || 500;
        if (status >= 500) console.error("[skills] request failed:", err);
        if (!res.headersSent) res.status(status).json({ message: status >= 500 ? "Something went wrong" : err?.message ?? "Request failed" });
    });
};

// /api/skills — the signed-in user's skill library (behind Firebase auth).
export function createSkillRouter(skills: SkillService): Router {
    const r = Router();
    const uid = (req: Request) => req.user!.sub;
    r.get("/", h(async (req, res) => res.json({ skills: await skills.list(uid(req)) })));
    // { markdown, fileName? } — a SKILL.md with name/description front matter.
    r.post("/import", h(async (req, res) => res.status(201).json(await skills.importMarkdown(uid(req), req.body?.markdown, req.body?.fileName))));
    r.post("/", h(async (req, res) => res.status(201).json(await skills.create(uid(req), req.body))));
    r.get("/:id", h(async (req, res) => res.json(await skills.get(uid(req), String(req.params.id)))));
    r.put("/:id", h(async (req, res) => res.json(await skills.update(uid(req), String(req.params.id), req.body ?? {}))));
    r.delete("/:id", h(async (req, res) => {
        await skills.remove(uid(req), String(req.params.id));
        res.status(204).send();
    }));
    return r;
}
