import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { EventBus, LiveEvent } from "../infra/events/event_bus";
import { registerGauge } from "../infra/observability";
import type { UpgradeHandler } from "./vanilla_gateway";

// The web app's live connection: wss://<host>/api/events.
//
// Protocol (JSON text frames):
//   client → {"type":"auth","token":"<Firebase ID token>"}   first frame, within 10 s
//   server → {"type":"ready"}                                 or close 4401
//   server → {"type":"event","event":"run.finished","data":{…},"ts":…}
//   client → {"type":"ping"}  /  server → {"type":"pong"}
//
// The token goes in a message, not the URL, so it never lands in proxy logs.
// Each user only receives their own events.

export const LIVE_PATH = "/api/events";
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_SOCKETS_PER_USER = 10;
const MAX_FRAME_BYTES = 8 * 1024;

export type VerifyToken = (token: string) => Promise<{ uid: string }>;

type Client = WebSocket & { userId?: string; alive?: boolean };

export class LiveSocketServer implements UpgradeHandler {
    private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    private byUser = new Map<string, Set<Client>>();
    private heartbeat: NodeJS.Timeout | null = null;
    private unsubscribe: (() => void) | null = null;

    private readonly authTimeoutMs: number;

    constructor(private bus: EventBus, private verify: VerifyToken, private allowedOrigins: string[] = [], opts: { authTimeoutMs?: number } = {}) {
        this.authTimeoutMs = opts.authTimeoutMs ?? AUTH_TIMEOUT_MS;
        registerGauge("owl_live_sockets", "Signed-in live-event sockets in this process", () => [...this.byUser.values()].reduce((n, s) => n + s.size, 0));
    }

    attach(server: http.Server): void {
        server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
        this.unsubscribe = this.bus.subscribe((userId, event) => this.send(userId, event));
        this.heartbeat = setInterval(() => {
            for (const c of this.wss.clients as Set<Client>) {
                if (c.alive === false) { c.terminate(); continue; }
                c.alive = false;
                c.ping();
            }
        }, HEARTBEAT_MS);
        this.heartbeat.unref();
    }

    close(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.unsubscribe?.();
        for (const c of this.wss.clients) c.close(1001, "server shutting down");
        this.wss.close();
    }

    private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
        const path = (req.url ?? "").split("?")[0];
        // Only this path; and only from the web app's origin when that's configured.
        const origin = req.headers.origin;
        if (path !== LIVE_PATH || (this.allowedOrigins.length && origin && !this.allowedOrigins.includes(origin))) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws as Client));
    }

    private onConnection(ws: Client) {
        ws.alive = true;
        ws.on("pong", () => { ws.alive = true; });
        const authTimer = setTimeout(() => ws.close(4401, "auth timeout"), this.authTimeoutMs);

        ws.on("message", async (data) => {
            let msg: any;
            try { msg = JSON.parse(data.toString()); } catch { return ws.close(4400, "invalid frame"); }
            if (!ws.userId) {
                if (msg?.type !== "auth" || typeof msg.token !== "string") return ws.close(4401, "auth required");
                try {
                    const { uid } = await this.verify(msg.token);
                    clearTimeout(authTimer);
                    if (ws.readyState !== WebSocket.OPEN) return;
                    ws.userId = uid;
                    this.add(uid, ws);
                    ws.send(JSON.stringify({ type: "ready" }));
                } catch {
                    ws.close(4401, "invalid token");
                }
                return;
            }
            if (msg?.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        });
        ws.on("close", () => {
            clearTimeout(authTimer);
            if (ws.userId) this.remove(ws.userId, ws);
        });
        ws.on("error", () => { /* closed by ws */ });
    }

    private add(userId: string, ws: Client) {
        let set = this.byUser.get(userId);
        if (!set) this.byUser.set(userId, (set = new Set()));
        set.add(ws);
        // Keep the newest few (old tabs left open).
        while (set.size > MAX_SOCKETS_PER_USER) {
            const oldest = set.values().next().value!;
            set.delete(oldest);
            oldest.close(4429, "too many connections");
        }
    }

    private remove(userId: string, ws: Client) {
        const set = this.byUser.get(userId);
        set?.delete(ws);
        if (set && !set.size) this.byUser.delete(userId);
    }

    private send(userId: string, event: LiveEvent) {
        const set = this.byUser.get(userId);
        if (!set?.size) return;
        const { type, ...data } = event;
        const frame = JSON.stringify({ type: "event", event: type, data, ts: Date.now() });
        for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
}
