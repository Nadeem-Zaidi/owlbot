import { NextFunction, Request, Response, Router } from "express";
import { NativeAgentService } from "../service/native_agents/native_agent_service";

type Handler = (req: Request, res: Response) => Promise<unknown>;

// Provider-native agents, mounted at /api/native-agents behind Firebase auth.
export function createNativeAgentRouter(service: NativeAgentService): Router {
    const r = Router();
    const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
        fn(req, res).catch((err: any) => {
            // Provider SDK errors carry the provider's HTTP status; pass its message on.
            const status = Number(err?.status ?? err?.statusCode) || 500;
            if (status >= 500) console.error("[native-agents] request failed:", err);
            if (!res.headersSent) res.status(status).json({ message: err?.message ?? "Request failed" });
        });
    };
    const uid = (req: Request) => req.user!.sub;
    const id = (req: Request) => String(req.params.id);
    const fid = (req: Request) => String(req.params.fid);
    const email = (req: Request) => req.user?.email;

    r.get("/", h(async (req, res) => res.json(await service.overview(uid(req), email(req)))));
    r.put("/active-provider", h(async (req, res) => res.json(await service.setActiveProvider(uid(req), req.body?.provider))));
    // Answer to a hosted-browser approval shown in a running chat.
    r.post("/approvals/:requestId", h(async (req, res) => res.json(await service.answerApproval(uid(req), String(req.params.requestId), req.body))));
    r.post("/", h(async (req, res) => res.status(201).json(await service.create(uid(req), req.body))));
    r.put("/:id", h(async (req, res) => res.json(await service.update(uid(req), id(req), req.body))));
    r.delete("/:id", h(async (req, res) => { await service.delete(uid(req), id(req)); res.status(204).end(); }));

    // HTTP functions and (owner-only) code functions; each change updates the provider's agent.
    r.get("/:id/functions", h(async (req, res) => res.json(await service.listFunctions(uid(req), email(req), id(req)))));
    r.post("/:id/functions/test", h(async (req, res) => res.json(await service.testFunction(uid(req), id(req), req.body))));
    r.post("/:id/functions", h(async (req, res) => res.status(201).json(await service.createFunction(uid(req), id(req), req.body))));
    r.put("/:id/functions/:fid", h(async (req, res) => res.json(await service.updateFunction(uid(req), id(req), fid(req), req.body))));
    r.delete("/:id/functions/:fid", h(async (req, res) => { await service.deleteFunction(uid(req), id(req), fid(req)); res.status(204).end(); }));
    r.post("/:id/code-functions/test", h(async (req, res) => res.json(await service.testCodeFunction(uid(req), email(req), id(req), req.body))));
    r.post("/:id/code-functions", h(async (req, res) => res.status(201).json(await service.createCodeFunction(uid(req), email(req), id(req), req.body))));
    r.put("/:id/code-functions/:fid", h(async (req, res) => res.json(await service.updateCodeFunction(uid(req), email(req), id(req), fid(req), req.body))));
    r.delete("/:id/code-functions/:fid", h(async (req, res) => { await service.deleteCodeFunction(uid(req), id(req), fid(req)); res.status(204).end(); }));
    return r;
}
