import { NextFunction, Request, Response, Router } from "express";
import { PortableService } from "../core/portable/portable_service";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const status = Number(err?.status ?? err?.statusCode) || 500;
        if (status >= 500) console.error("[portable] request failed:", err);
        if (!res.headersSent) res.status(status).json({ message: status >= 500 ? "Something went wrong" : err?.message ?? "Request failed" });
    });
};

const safeFile = (name: string) => `${name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "export"}.owlbot.json`;

// /api/portable — export agents / Agent Studio projects as JSON, and import
// them (behind Firebase auth). Files never contain secrets.
export function createPortableRouter(svc: PortableService): Router {
    const r = Router();
    const uid = (req: Request) => req.user!.sub;
    const email = (req: Request) => req.user!.email ?? undefined;
    const send = (res: Response, file: any, name: string) => {
        res.setHeader("Content-Disposition", `attachment; filename="${safeFile(name)}"`);
        res.json(file);
    };

    r.get("/agents/:id/export", h(async (req, res) => {
        const file = await svc.exportAgent(uid(req), String(req.params.id));
        send(res, file, file.agents[0]?.name ?? "agent");
    }));
    r.get("/studio/:id/export", h(async (req, res) => {
        const file = await svc.exportProject(uid(req), String(req.params.id));
        send(res, file, file.projects[0]?.name ?? "project");
    }));
    // { file } → what an import would create, needs and warns about (nothing saved).
    r.post("/import/preview", h(async (req, res) => res.json(await svc.preview(uid(req), req.body?.file, email(req)))));
    // { file, choices } → creates everything, or nothing.
    r.post("/import", h(async (req, res) => res.status(201).json(await svc.import(uid(req), req.body?.file, req.body?.choices ?? {}, email(req)))));
    return r;
}
