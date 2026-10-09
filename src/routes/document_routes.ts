import express, { NextFunction, Request, Response, Router } from "express";
import { DocumentService, FONT_CHOICES } from "../core/documents/document_service";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const status = Number(err?.status ?? err?.statusCode) || 500;
        if (status >= 500) console.error("[documents] request failed:", err);
        if (!res.headersSent) res.status(status).json({ message: status >= 500 ? "Something went wrong" : err?.message ?? "Request failed" });
    });
};

// "Q3 report.docx" → RFC 5987 header that works with any characters.
const disposition = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

// /api/documents — download generated Word/Excel files and set your
// document style. Behind Firebase auth; scoped to the signed-in user.
export function createDocumentRouter(docs: DocumentService): Router {
    const r = Router();
    const uid = (req: Request) => req.user!.sub;

    r.get("/style", h(async (req, res) => res.json({ ...(await docs.style(uid(req))), fonts: FONT_CHOICES })));
    r.put("/style", h(async (req, res) => res.json(await docs.saveStyle(uid(req), req.body ?? {}))));
    // { image: "data:image/png;base64,…" }
    r.put("/style/logo", express.json({ limit: "1mb" }), h(async (req, res) => res.json(await docs.saveLogo(uid(req), req.body?.image))));
    r.delete("/style/logo", h(async (req, res) => res.json(await docs.removeLogo(uid(req)))));
    r.get("/style/logo", h(async (req, res) => {
        const logo = await docs.logo(uid(req));
        if (!logo) return res.status(404).json({ message: "No logo" });
        res.setHeader("Content-Type", logo.mime);
        res.setHeader("Cache-Control", "private, no-store");
        res.send(logo.buffer);
    }));

    r.get("/:id/preview", h(async (req, res) => {
        const json = await docs.preview(uid(req), String(req.params.id));
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "private, no-store");
        res.send(json);
    }));

    r.get("/:id/download", h(async (req, res) => {
        const f = await docs.load(uid(req), String(req.params.id));
        res.setHeader("Content-Type", f.mime);
        res.setHeader("Content-Disposition", disposition(f.filename));
        res.setHeader("X-File-Name", encodeURIComponent(f.filename));
        res.setHeader("Cache-Control", "private, no-store");
        res.send(f.buffer);
    }));
    return r;
}
