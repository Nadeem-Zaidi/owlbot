import { NextFunction, Request, Response } from "express";
import { AgentService } from "../service/agents/agent_service";
import { AgentScheduler } from "../service/agents/agent_scheduler";
import { BaseRouter } from "./base_router";

type Handler = (req: Request, res: Response) => Promise<unknown>;

// Agents API, mounted at /api/agents behind the usual Firebase auth.
// Every handler is scoped to req.user.sub inside AgentService.
export class AgentRoutes extends BaseRouter<AgentService> {
    private scheduler?: AgentScheduler;

    constructor(agents: AgentService) {
        super("/agents", agents);
    }

    setScheduler(scheduler: AgentScheduler) {
        this.scheduler = scheduler;
    }

    // Errors come back as JSON with the right status instead of Express's HTML page.
    private h(fn: Handler) {
        return (req: Request, res: Response, _next: NextFunction) => {
            fn(req, res).catch((err: any) => {
                const status = err?.status ?? err?.statusCode ?? 500;
                if (status >= 500) console.error("[agents] request failed:", err);
                if (!res.headersSent) res.status(status).json({ message: status >= 500 && !err?.status ? "Something went wrong" : err?.message ?? "Request failed" });
            });
        };
    }

    registerRouter(): void {
        const r = this.router;
        const uid = (req: Request) => req.user!.sub;
        const p = (req: Request, key: string) => String(req.params[key]);

        r.get("/catalog", this.h(async (req, res) => res.json(this.service.catalog(req.user?.email))));

        // "Describe it" → draft configuration (nothing is saved)
        r.post("/draft", this.h(async (req, res) => res.json(await this.service.draft(uid(req), req.body?.description))));

        // Connect to an MCP server and list its tools before adding it
        r.post("/mcp/discover", this.h(async (req, res) => res.json({ tools: await this.service.discoverMcp(req.body) })));

        // ── agents ──
        r.get("/", this.h(async (req, res) => res.json({ agents: await this.service.list(uid(req)) })));
        r.post("/", this.h(async (req, res) => res.status(201).json(await this.service.create(uid(req), req.body))));
        r.get("/:id", this.h(async (req, res) => res.json(await this.service.get(uid(req), p(req, "id")))));
        r.put("/:id", this.h(async (req, res) => res.json(await this.service.update(uid(req), p(req, "id"), req.body))));
        r.delete("/:id", this.h(async (req, res) => {
            await this.service.remove(uid(req), p(req, "id"));
            res.status(204).send();
        }));

        // ── HTTP functions ──
        r.post("/:id/functions", this.h(async (req, res) => res.status(201).json(await this.service.createFunction(uid(req), p(req, "id"), req.body))));
        r.post("/:id/functions/test", this.h(async (req, res) => res.json(await this.service.testFunction(uid(req), p(req, "id"), req.body))));
        r.put("/:id/functions/:fid", this.h(async (req, res) => res.json(await this.service.updateFunction(uid(req), p(req, "id"), p(req, "fid"), req.body))));
        r.delete("/:id/functions/:fid", this.h(async (req, res) => {
            await this.service.deleteFunction(uid(req), p(req, "id"), p(req, "fid"));
            res.status(204).send();
        }));

        // ── code functions (Python; owner only) ──
        const email = (req: Request) => req.user?.email;
        r.post("/:id/code-functions", this.h(async (req, res) => res.status(201).json(await this.service.createCodeFunction(uid(req), email(req), p(req, "id"), req.body))));
        r.post("/:id/code-functions/test", this.h(async (req, res) => res.json(await this.service.testCodeFunction(uid(req), email(req), p(req, "id"), req.body))));
        r.put("/:id/code-functions/:cid", this.h(async (req, res) => res.json(await this.service.updateCodeFunction(uid(req), email(req), p(req, "id"), p(req, "cid"), req.body))));
        r.delete("/:id/code-functions/:cid", this.h(async (req, res) => {
            await this.service.deleteCodeFunction(uid(req), p(req, "id"), p(req, "cid"));
            res.status(204).send();
        }));

        // ── MCP servers ──
        r.post("/:id/mcp", this.h(async (req, res) => res.status(201).json(await this.service.addMcpServer(uid(req), p(req, "id"), req.body))));
        r.put("/:id/mcp/:mid", this.h(async (req, res) => res.json(await this.service.updateMcpServer(uid(req), p(req, "id"), p(req, "mid"), req.body))));
        r.post("/:id/mcp/:mid/refresh", this.h(async (req, res) => res.json(await this.service.refreshMcpServer(uid(req), p(req, "id"), p(req, "mid")))));
        r.delete("/:id/mcp/:mid", this.h(async (req, res) => {
            await this.service.deleteMcpServer(uid(req), p(req, "id"), p(req, "mid"));
            res.status(204).send();
        }));

        // ── schedules ──
        r.post("/:id/schedules", this.h(async (req, res) => res.status(201).json(await this.service.createSchedule(uid(req), p(req, "id"), req.body))));
        r.put("/:id/schedules/:sid", this.h(async (req, res) => res.json(await this.service.updateSchedule(uid(req), p(req, "id"), p(req, "sid"), req.body))));
        r.delete("/:id/schedules/:sid", this.h(async (req, res) => {
            await this.service.deleteSchedule(uid(req), p(req, "id"), p(req, "sid"));
            res.status(204).send();
        }));
        r.post("/:id/schedules/:sid/run", this.h(async (req, res) => {
            if (!this.scheduler) return res.status(503).json({ message: "Scheduling isn't running on this server" });
            const schedule = await this.service.getSchedule(uid(req), p(req, "id"), p(req, "sid"));
            await this.scheduler.runNow(schedule);
            return res.status(202).json({ started: true });
        }));

        r.get("/:id/runs", this.h(async (req, res) => res.json({ runs: await this.service.listRuns(uid(req), p(req, "id")) })));
    }
}
