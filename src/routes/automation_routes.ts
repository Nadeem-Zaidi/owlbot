import { NextFunction, Request, Response, Router } from "express";
import { AutomationService } from "../core/automations/automation_service";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const status = Number(err?.status ?? err?.statusCode) || 500;
        if (status >= 500) console.error("[automations] request failed:", err);
        if (!res.headersSent) res.status(status).json({ message: status >= 500 ? "Something went wrong" : err?.message ?? "Request failed" });
    });
};

// /api/automations — reminders, to-dos, web watchers and alerts (behind Firebase auth).
export function createAutomationRouter(svc: AutomationService): Router {
    const r = Router();
    const uid = (req: Request) => req.user!.sub;
    const id = (req: Request) => String(req.params.id);

    r.get("/settings", h(async (req, res) => res.json(await svc.settings(uid(req)))));
    r.put("/settings", h(async (req, res) => {
        await svc.setTimezone(uid(req), req.body?.timezone);
        res.json(await svc.settings(uid(req)));
    }));

    r.get("/tasks", h(async (req, res) => res.json({ tasks: await svc.listTasks(uid(req), req.query.status === "all" ? "all" : "open") })));
    r.post("/tasks", h(async (req, res) => res.status(201).json(await svc.createTask(uid(req), req.body, "web"))));
    r.put("/tasks/:id", h(async (req, res) => res.json(await svc.updateTask(uid(req), id(req), req.body))));
    r.post("/tasks/:id/status", h(async (req, res) => res.json(await svc.setTaskStatus(uid(req), id(req), req.body?.status))));
    r.delete("/tasks/:id", h(async (req, res) => {
        await svc.deleteTask(uid(req), id(req));
        res.status(204).send();
    }));

    r.get("/watchers", h(async (req, res) => res.json({ watchers: await svc.listWatchers(uid(req)) })));
    r.post("/watchers", h(async (req, res) => res.status(201).json(await svc.createWatcher(uid(req), req.body))));
    r.put("/watchers/:id", h(async (req, res) => res.json(await svc.updateWatcher(uid(req), id(req), req.body))));
    r.post("/watchers/:id/status", h(async (req, res) => res.json(await svc.setWatcherStatus(uid(req), id(req), req.body?.status))));
    r.post("/watchers/:id/check", h(async (req, res) => res.json(await svc.checkNow(uid(req), id(req)))));
    r.delete("/watchers/:id", h(async (req, res) => {
        await svc.deleteWatcher(uid(req), id(req));
        res.status(204).send();
    }));

    r.get("/alerts", h(async (req, res) => res.json(await svc.alerts(uid(req)))));
    r.get("/alerts/unread", h(async (req, res) => res.json({ unread: await svc.unread(uid(req)) })));
    r.post("/alerts/read", h(async (req, res) => {
        await svc.markRead(uid(req));
        res.status(204).send();
    }));
    return r;
}
