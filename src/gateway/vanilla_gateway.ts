import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import { apiRateLimit, chatRateLimit } from "../infra/rate_limit";
import { redisReady } from "../infra/redis";
import { verifyToken } from "../authentication/authentication_middleware";
import { metricsHandler, requestContext, userContext } from "../infra/observability";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { ChatMessages } from "../routes/session_routes";
import { StorageRoutes } from "../routes/storage_routes";
import { WhatsAppRoutes } from "../routes/whatsapp_routes";
import { AgentRoutes } from "../routes/agent_routes";
import { PipelineRoutes } from "../routes/pipeline_routes";

// Something that takes over WebSocket upgrades on the HTTP server (the
// live-events socket, gateway/live_socket.ts).
export interface UpgradeHandler {
    attach(server: http.Server): void;
    close(): void;
}

// The HTTP entry point: middleware order, routes, health checks, graceful
// shutdown. (The old unauthenticated JSON-RPC WebSocket that lived here is
// gone; live updates use the authenticated socket in live_socket.ts.)
export class VGateway {
    private port?: number;
    private app = express();
    private server = http.createServer(this.app);
    private db: IDatabaseAdapter;
    private chatRoutes: ChatMessages;
    private storageRoutes: StorageRoutes;
    private upgrades: UpgradeHandler[] = [];
    private shuttingDown = false;
    // Live counters for /healthz (e.g. turns running), set from main.ts.
    private status?: () => Record<string, number>;

    constructor(
        port: number,
        db: IDatabaseAdapter,
        chatRoutes: ChatMessages,
        storageRoutes: StorageRoutes,
        private whatsappRoutes?: WhatsAppRoutes,
        private agentRoutes?: AgentRoutes,
        private pipelineRoutes?: PipelineRoutes,
        // Plain Express routers mounted as-is, e.g. { path: "/api/search", router }.
        private extraRouters: { path: string; router: express.Router }[] = [],
        // Routes that must work without a Firebase login and get the raw body
        // (e.g. payment webhooks, which carry their own signature).
        private publicRouters: { path: string; router: express.Router }[] = []
    ) {
        this.port = port;
        this.db = db;
        this.chatRoutes = chatRoutes;
        this.storageRoutes = storageRoutes;
    }

    public setStatus(fn: () => Record<string, number>): void {
        this.status = fn;
    }

    public addUpgradeHandler(handler: UpgradeHandler): void {
        this.upgrades.push(handler);
        handler.attach(this.server);
    }

    public async init() {
        // Behind a load balancer / reverse proxy, trust its X-Forwarded-For so
        // rate limits see the real client IP. Default: private networks only.
        this.app.set("trust proxy", process.env.TRUST_PROXY ?? "loopback, linklocal, uniquelocal");
        this.app.disable("x-powered-by");
        // Request id + log context + access log + HTTP metrics, for everything below.
        this.app.use(requestContext());
        // JSON API: security headers, but let the web app (another origin) load files.
        this.app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
        const origins = (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
        if (!origins.length && process.env.NODE_ENV === "production") {
            console.warn("[gateway] CORS_ORIGINS is not set — any website can call this API. Set it to your web app's origin(s).");
        }
        // exposedHeaders: without it the browser hides custom response headers
        // from JS across origins (X-File-Name for code-interpreter downloads,
        // X-Request-Id for support/debugging).
        this.app.use(cors({ origin: origins.length ? origins : true, exposedHeaders: ["X-File-Name", "Content-Disposition", "X-Request-Id"] }));

        // Health checks for the load balancer / orchestrator (no auth).
        this.app.get("/healthz", (_req, res) => { res.status(200).json({ ok: true, ...(this.status?.() ?? {}) }); });
        this.app.get("/readyz", async (_req, res) => {
            if (this.shuttingDown) return res.status(503).json({ ok: false, reason: "shutting down" });
            try {
                await this.db.query("SELECT 1");
            } catch {
                return res.status(503).json({ ok: false, reason: "database" });
            }
            if (!(await redisReady())) return res.status(503).json({ ok: false, reason: "redis" });
            return res.status(200).json({ ok: true });
        });

        // Prometheus scrape endpoint (bearer METRICS_TOKEN; off without it).
        this.app.get("/metrics", metricsHandler());

        for (const { path, router } of this.publicRouters) this.app.use(path, router);
        this.app.use(verifyToken);
        this.app.use(userContext());
        // Per-user limits (shared across processes when REDIS_URL is set).
        this.app.use(apiRateLimit());
        this.app.use("/api/chat_stream", chatRateLimit());
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ limit: '10mb', extended: true }));
        // Mounted before /api so /api/whatsapp/* isn't swallowed by the chat router.
        if (this.whatsappRoutes) this.app.use("/api/whatsapp", this.whatsappRoutes.getRouter());
        if (this.agentRoutes) this.app.use("/api/agents", this.agentRoutes.getRouter());
        if (this.pipelineRoutes) this.app.use("/api/pipelines", this.pipelineRoutes.getRouter());
        for (const { path, router } of this.extraRouters) this.app.use(path, router);
        this.chatRoutes.registerRouter()
        this.app.use("/api", this.chatRoutes.getRouter());
        this.storageRoutes.registerRouter();
        this.app.use("/",this.storageRoutes.getRouter());
    }

    // Graceful shutdown: /readyz fails so the LB stops sending traffic, no new
    // connections are accepted, and open requests (e.g. streaming replies) get
    // up to `graceMs` to finish.
    public async close(graceMs = 25_000): Promise<void> {
        this.shuttingDown = true;
        for (const u of this.upgrades) u.close();
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.server.closeAllConnections?.();
                resolve();
            }, graceMs);
            this.server.close(() => { clearTimeout(timer); resolve(); });
            this.server.closeIdleConnections?.();
        });
    }

    public listen() {
        // Longer than a typical load balancer idle timeout (60 s), so the LB
        // never reuses a connection the server has just closed.
        this.server.keepAliveTimeout = 65_000;
        this.server.headersTimeout = 66_000;
        this.server.listen(this.port, () => {
            console.log(`HTTP Server listening on port ${this.port}${process.env.WORKER_INDEX ? ` (worker ${process.env.WORKER_INDEX})` : ""}`);
        });
    }
}
