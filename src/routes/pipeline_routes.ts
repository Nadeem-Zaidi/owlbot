import { NextFunction, Request, Response } from "express";
import { PipelineService } from "../service/agents/pipeline_service";
import { BaseRouter } from "./base_router";

type Handler = (req: Request, res: Response) => Promise<unknown>;

// Agent pipelines API, mounted at /api/pipelines behind Firebase auth.
export class PipelineRoutes extends BaseRouter<PipelineService> {
    constructor(pipelines: PipelineService) {
        super("/pipelines", pipelines);
    }

    private h(fn: Handler) {
        return (req: Request, res: Response, _next: NextFunction) => {
            fn(req, res).catch((err: any) => {
                const status = err?.status ?? err?.statusCode ?? 500;
                if (status >= 500) console.error("[pipelines] request failed:", err);
                if (!res.headersSent) res.status(status).json({ message: status >= 500 && !err?.status ? "Something went wrong" : err?.message ?? "Request failed" });
            });
        };
    }

    registerRouter(): void {
        const r = this.router;
        const uid = (req: Request) => req.user!.sub;
        const p = (req: Request, key: string) => String(req.params[key]);

        r.get("/", this.h(async (req, res) => res.json({ pipelines: await this.service.list(uid(req)) })));
        r.post("/", this.h(async (req, res) => res.status(201).json(await this.service.create(uid(req), req.body))));
        r.get("/runs/:runId", this.h(async (req, res) => res.json(await this.service.getRun(uid(req), Number(p(req, "runId"))))));
        r.get("/:id", this.h(async (req, res) => res.json(await this.service.get(uid(req), p(req, "id")))));
        r.put("/:id", this.h(async (req, res) => res.json(await this.service.update(uid(req), p(req, "id"), req.body))));
        r.delete("/:id", this.h(async (req, res) => {
            await this.service.remove(uid(req), p(req, "id"));
            res.status(204).send();
        }));
        r.post("/:id/run", this.h(async (req, res) => res.status(202).json(await this.service.start(uid(req), p(req, "id"), req.body?.input))));
    }
}
