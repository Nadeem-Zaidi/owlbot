import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextFunction, Request, RequestHandler, Response } from "express";
import { setLogContext, withLogContext } from "./context";
import { logger } from "./logger";
import { metrics, renderMetrics } from "./metrics";

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,100}$/;
const QUIET_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);

// Gives every request an id (the client's X-Request-Id when it's sane, a new
// one otherwise), returns it in the response, runs the request with it in
// the log context, and records one access-log line and the HTTP metrics.
export function requestContext(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const incoming = req.header("x-request-id");
        const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader("X-Request-Id", requestId);
        const start = process.hrtime.bigint();
        const quiet = QUIET_PATHS.has(req.path);

        res.on("finish", () => done(false));
        res.on("close", () => done(!res.writableFinished));
        let logged = false;
        const done = (aborted: boolean) => {
            if (logged) return;
            logged = true;
            const seconds = Number(process.hrtime.bigint() - start) / 1e9;
            // Route templates (/api/agents/:id), never raw paths, so metrics stay bounded.
            const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : (res.statusCode === 404 ? "unmatched" : req.baseUrl || "other");
            const status = aborted ? "aborted" : `${Math.floor(res.statusCode / 100)}xx`;
            metrics.httpRequests.inc({ method: req.method, route, status });
            metrics.httpDuration.observe(seconds, { method: req.method, route });
            if (!quiet) {
                logger.info({ requestId, userId: (req as any).user?.sub, method: req.method, route, status: res.statusCode, aborted: aborted || undefined, ms: Math.round(seconds * 1000) }, "request");
            }
        };
        withLogContext({ requestId }, () => next());
    };
}

// After token verification: the user id joins the log context.
export function userContext(): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
        if ((req as any).user?.sub) setLogContext({ userId: (req as any).user.sub });
        next();
    };
}

// GET /metrics — Prometheus text format. Off unless METRICS_TOKEN is set;
// scrapers send it as a bearer token. (Behind Caddy every request comes from
// a private address, so "internal only" can't be decided by IP.)
export function metricsHandler(): RequestHandler {
    const token = process.env.METRICS_TOKEN?.trim();
    return (req: Request, res: Response) => {
        if (!token) return res.status(404).json({ message: "Metrics are off (set METRICS_TOKEN)." });
        const given = Buffer.from((req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
        const want = Buffer.from(token);
        if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ message: "Unauthorized" });
        res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        res.send(renderMetrics());
    };
}
