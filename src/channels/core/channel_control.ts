import { randomUUID } from "node:crypto";
import type Redis from "ioredis";

// Lets any API process see and steer a messaging app that runs in another
// process (the "jobs" process, ROLE=jobs) — so API servers can scale out
// while one process holds the WhatsApp login / polls the Telegram bot.
//
//   status   — a snapshot the host refreshes in Redis every few seconds
//   commands — pair / continue a chat, sent to the host over Redis pub/sub
//              and answered on the caller's reply channel (with a timeout)
//
// In the process that hosts the channel everything is called directly.
// Without Redis, only the hosting process can reach the channel.

export type ChannelSnapshot = {
    state: string;
    botNumber?: string;   // WhatsApp
    botHandle?: string;   // "@bot" on Telegram
    qr?: string;          // WhatsApp pairing QR while awaiting_qr
    selfChat?: boolean;   // WhatsApp self-chat mode
    at: number;
};

// What a hosting process offers (its manager, while the channel runs).
export type LocalChannelHost = {
    snapshot(): Omit<ChannelSnapshot, "at"> | null; // null = not running here
    pair?(): Promise<void>;
    continueSession?(userId: string, sessionId: string): Promise<boolean>;
    notifyUser?(userId: string, markdown: string): Promise<boolean>;
};

export interface ChannelControl {
    readonly channel: string;
    // null when the channel isn't running anywhere.
    status(): Promise<ChannelSnapshot | null>;
    pair(): Promise<void>;
    continueSession(userId: string, sessionId: string): Promise<boolean>;
    // Sends a message to the user's linked chat; false if not linked.
    notifyUser(userId: string, markdown: string): Promise<boolean>;
}

export class ChannelUnavailableError extends Error {
    readonly status = 503;
}

const SNAPSHOT_EVERY_MS = 3_000;
const SNAPSHOT_TTL_MS = 10_000;
const RPC_TIMEOUT_MS = 10_000;
const statusKey = (channel: string) => `owl:channel:${channel}:status`;
const requestChannel = (channel: string) => `owl:rpc:${channel}`;
const replyChannel = (origin: string) => `owl:rpc:reply:${origin}`;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class ChannelControlHub {
    private hosts = new Map<string, LocalChannelHost>();
    private pending = new Map<string, Pending>();
    private readonly origin = randomUUID();
    private timer: NodeJS.Timeout | null = null;
    private started = false;

    private readonly rpcTimeoutMs: number;
    private readonly snapshotEveryMs: number;

    constructor(private pub: () => Redis | null = () => null, private sub: () => Redis | null = () => null, opts: { rpcTimeoutMs?: number; snapshotEveryMs?: number } = {}) {
        this.rpcTimeoutMs = opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
        this.snapshotEveryMs = opts.snapshotEveryMs ?? SNAPSHOT_EVERY_MS;
    }

    // Call for each channel this process may host (before start()).
    registerHost(channel: string, host: LocalChannelHost): void {
        this.hosts.set(channel, host);
    }

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        const sub = this.sub();
        if (!sub) return;
        sub.on("message", (ch: string, raw: string) => void this.onMessage(ch, raw));
        await sub.subscribe(replyChannel(this.origin), ...[...this.hosts.keys()].map(requestChannel))
            .catch((err: Error) => console.warn(`[channels] Redis subscribe failed (${err.message}); channels reachable from their own process only`));
        if (this.hosts.size) {
            this.timer = setInterval(() => void this.publishSnapshots(), this.snapshotEveryMs);
            this.timer.unref();
            void this.publishSnapshots();
        }
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ChannelUnavailableError("shutting down")); }
        this.pending.clear();
    }

    control(channel: string): ChannelControl {
        return {
            channel,
            status: () => this.status(channel),
            pair: async () => { await this.command(channel, "pair", []); },
            continueSession: async (userId, sessionId) => Boolean(await this.command(channel, "continueSession", [userId, sessionId])),
            notifyUser: async (userId, markdown) => Boolean(await this.command(channel, "notifyUser", [userId, markdown])),
        };
    }

    private local(channel: string) {
        const host = this.hosts.get(channel);
        const snap = host?.snapshot();
        return host && snap ? { host, snap } : null;
    }

    private async status(channel: string): Promise<ChannelSnapshot | null> {
        const local = this.local(channel);
        if (local) return { ...local.snap, at: Date.now() };
        const r = this.pub();
        if (!r) return null;
        try {
            const raw = await r.get(statusKey(channel));
            return raw ? (JSON.parse(raw) as ChannelSnapshot) : null;
        } catch {
            return null;
        }
    }

    private async command(channel: string, op: "pair" | "continueSession" | "notifyUser", args: string[]): Promise<unknown> {
        const local = this.local(channel);
        if (local) return this.run(local.host, op, args);
        const r = this.pub();
        if (!r) throw new ChannelUnavailableError(`${channel} isn't running on this server.`);
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new ChannelUnavailableError(`${channel} didn't respond — it may be restarting. Try again in a moment.`));
            }, this.rpcTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            r.publish(requestChannel(channel), JSON.stringify({ id, origin: this.origin, op, args })).catch((err) => {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new ChannelUnavailableError(`Couldn't reach ${channel}: ${err.message}`));
            });
        });
    }

    private async run(host: LocalChannelHost, op: string, args: string[]): Promise<unknown> {
        if (op === "pair") {
            if (!host.pair) throw new Error("pairing isn't supported on this channel");
            await host.pair();
            return true;
        }
        if (op === "continueSession") {
            if (!host.continueSession) throw new Error("not supported on this channel");
            return host.continueSession(args[0], args[1]);
        }
        if (op === "notifyUser") {
            if (!host.notifyUser) throw new Error("not supported on this channel");
            return host.notifyUser(args[0], args[1]);
        }
        throw new Error(`unknown command ${op}`);
    }

    private async onMessage(ch: string, raw: string) {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (ch === replyChannel(this.origin)) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(Object.assign(new Error(msg.error), { status: msg.status ?? 500 }));
            else p.resolve(msg.result);
            return;
        }
        const channel = ch.startsWith("owl:rpc:") ? ch.slice("owl:rpc:".length) : null;
        const local = channel ? this.local(channel) : null;
        // Only the process actually running the channel answers.
        if (!local || typeof msg.id !== "string" || typeof msg.origin !== "string") return;
        const r = this.pub();
        if (!r) return;
        let reply: object;
        try {
            const args = Array.isArray(msg.args) ? msg.args.map(String) : [];
            reply = { id: msg.id, result: await this.run(local.host, String(msg.op), args) };
        } catch (err: any) {
            reply = { id: msg.id, error: err?.message ?? "failed", status: err?.status };
        }
        await r.publish(replyChannel(msg.origin), JSON.stringify(reply)).catch(() => {});
    }

    private async publishSnapshots() {
        const r = this.pub();
        if (!r) return;
        for (const [channel, host] of this.hosts) {
            const snap = host.snapshot();
            if (!snap) continue; // not running here: let the key expire
            await r.set(statusKey(channel), JSON.stringify({ ...snap, at: Date.now() }), "PX", SNAPSHOT_TTL_MS).catch(() => {});
        }
    }
}
