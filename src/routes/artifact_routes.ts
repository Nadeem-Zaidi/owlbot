import { NextFunction, Request, Response, Router } from "express";
import { ArtifactRepository } from "../repository/artifact_repository";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        console.error("[artifacts] request failed:", err);
        if (!res.headersSent) res.status(500).json({ message: "Something went wrong" });
    });
};

const UUID = /^[0-9a-f-]{36}$/i;

// /api/artifacts — documents the assistant created, for the side panel.
// Content is returned as JSON and rendered by the web app in a sandboxed
// frame; it's never served as text/html from this origin.
export function createArtifactRouter(repo: ArtifactRepository): Router {
    const r = Router();

    r.get("/:id", h(async (req, res) => {
        const id = String(req.params.id);
        if (!UUID.test(id)) return res.status(404).json({ message: "Not found" });
        const art = await repo.get(req.user!.sub, id);
        if (!art) return res.status(404).json({ message: "Not found" });
        const requested = Number(req.query.version);
        const versionNo = Number.isInteger(requested) && requested >= 1 && requested <= art.current_version ? requested : art.current_version;
        const [version, versions] = await Promise.all([repo.version(id, versionNo), repo.versions(id)]);
        return res.json({
            id: art.id,
            kind: art.kind,
            title: version?.title ?? art.title,
            version: versionNo,
            currentVersion: art.current_version,
            content: version?.content ?? "",
            versions: versions.map((v) => ({ version: v.version, title: v.title, changeSummary: v.change_summary, createdAt: v.created_at })),
            createdAt: art.created_at,
            updatedAt: art.updated_at,
        });
    }));

    return r;
}
