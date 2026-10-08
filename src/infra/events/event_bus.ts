import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { metrics } from "../observability";

// Live events for the web app (OpenClaw's gateway events). Small and typed;
// only ids and states, never message content.
export type LiveEvent =
    | { type: "run.started"; sessionId: string; runId: string; channel: string }
    | { type: "run.finished"; sessionId: string; runId: string; channel: string; status: string };

type Listener = (userId: string, event: LiveEvent) => void;

const CHANNEL = "owl:events";

// Delivers events to every process: listeners in this one directly, other
// processes/servers through Redis pub/sub (when REDIS_URL is set). Each
// process ignores its own messages coming back from Redis.
export class EventBus {
    private listeners = new Set<Listener>();
    private readonly origin = randomUUID();
    private started = false;

    constructor(private pub: () => Redis | null = () => null, private sub: () => Redis | null = () => null) {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        const sub = this.sub();
        if (!sub) return;
        sub.on("message", (channel: string, raw: string) => {
            if (channel !== CHANNEL) return;
            try {
                const m = JSON.parse(raw);
                if (m.origin === this.origin || typeof m.userId !== "string" || !m.event?.type) return;
                this.deliver(m.userId, m.event);
            } catch {
                // malformed — ignore
            }
        });
        await sub.subscribe(CHANNEL).catch((err: Error) => console.warn(`[events] Redis subscribe failed (${err.message}); live events stay within this process`));
    }

    publish(userId: string, event: LiveEvent): void {
        metrics.eventsPublished.inc({ type: event.type });
        this.deliver(userId, event);
        const pub = this.pub();
        if (pub) void pub.publish(CHANNEL, JSON.stringify({ origin: this.origin, userId, event })).catch(() => {});
    }

    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private deliver(userId: string, event: LiveEvent) {
        for (const fn of this.listeners) {
            try { fn(userId, event); } catch (err) { console.error("[events] listener failed:", err); }
        }
    }
}
