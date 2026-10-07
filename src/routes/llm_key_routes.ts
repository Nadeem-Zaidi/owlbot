import { NextFunction, Request, Response, Router } from "express";
import { ModelRegistry } from "../service/model_registry";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const status = Number(err?.status ?? err?.statusCode) || 500;
        if (status >= 500 && status !== 502) console.error("[llm-keys] request failed:", err);
        if (!res.headersSent) res.status(status).json({ message: status >= 500 && status !== 502 ? "Something went wrong" : err?.message ?? "Request failed" });
    });
};

// /api/llm-keys — a user's own model API keys (BYOK). Behind Firebase auth;
// every call is scoped to the signed-in user. Keys are write-only: responses
// carry a hint (last 4 characters), never the key.
export function createLLMKeyRouter(registry: ModelRegistry): Router {
    const r = Router();
    const uid = (req: Request) => req.user!.sub;
    r.get("/", h(async (req, res) => res.json({ keys: await registry.listKeys(uid(req)) })));
    // Check a key and list its models before saving (or re-check a saved one: { id }).
    r.post("/test", h(async (req, res) => res.json(await registry.test(uid(req), req.body))));
    r.post("/", h(async (req, res) => res.status(201).json(await registry.createKey(uid(req), req.body))));
    r.put("/:id", h(async (req, res) => res.json(await registry.updateKey(uid(req), String(req.params.id), req.body))));
    r.delete("/:id", h(async (req, res) => {
        await registry.deleteKey(uid(req), String(req.params.id));
        res.status(204).send();
    }));
    return r;
}
