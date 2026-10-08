import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { redis } from "../../infra/redis";

// One turn at a time per session, any number of sessions in parallel.
//
// Two messages for the same chat (two browser tabs, a fast double-send, the
// web app and WhatsApp on one chat) used to start two model runs at once:
// both read the same history, both answered, and their saved messages
// interleaved. Each session now has a FIFO lane; a turn waits for the one
// before it.
//
// In one process the lane is a promise chain. With REDIS_URL set, the turn
// also holds a short-lived Redis lock (renewed while it runs), so the rule
// holds across cluster workers and servers too.

export class LaneFullError extends Error {
    constructor(public readonly waiting: number) {
        super("Too many messages are waiting in this chat. Wait for the current reply to finish.");
    }
}

export class LaneTimeoutError extends Error {
    constructor() {
        super("This chat is still busy with an earlier message. Try again in a moment.");
    }
}

export type LaneRelease = () => void;

type LaneOptions = {
    // Max turns waiting behind the running one, per session.
    cap?: number;
    // Give up waiting after this long.
    maxWaitMs?: number;
    // Redis lock lifetime; renewed every third of it while the turn runs, so
    // a crashed process frees the chat within this time.
    lockTtlMs?: number;
    redis?: () => Redis | null;
};

const LOCK_PREFIX = "owl:lane:";
// Delete the lock only if we still own it.
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

export class SessionLanes {
    private tails = new Map<string, Promise<void>>();
    private depth = new Map<string, number>();
    private readonly cap: number;
    private readonly maxWaitMs: number;
    private readonly lockTtlMs: number;
    private readonly getRedis: () => Redis | null;
    private redisWarned = false;

    constructor(opts: LaneOptions = {}) {
        this.cap = opts.cap ?? 20;
        this.maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
        this.lockTtlMs = opts.lockTtlMs ?? 30_000;
        this.getRedis = opts.redis ?? redis;
    }

    // Turns queued or running for a session (0 when idle).
    waiting(sessionId: string): number {
        return this.depth.get(sessionId) ?? 0;
    }

    // Sessions with a turn queued or running in this process.
    activeSessions(): number {
        return this.depth.size;
    }

    // Resolves when it's this turn's go; call the returned release() when the
    // turn ends. Rejects with LaneFullError / LaneTimeoutError, or an
    // AbortError when `signal` fires while waiting.
    async acquire(sessionId: string, signal?: AbortSignal, onQueued?: (ahead: number) => void): Promise<LaneRelease> {
        const ahead = this.depth.get(sessionId) ?? 0;
        if (ahead > this.cap) throw new LaneFullError(ahead);
        this.depth.set(sessionId, ahead + 1);

        let releaseLocal!: () => void;
        const mine = new Promise<void>((resolve) => { releaseLocal = resolve; });
        const previous = this.tails.get(sessionId) ?? Promise.resolve();
        const tail = previous.then(() => mine);
        this.tails.set(sessionId, tail);

        const finish = () => {
            releaseLocal();
            const left = (this.depth.get(sessionId) ?? 1) - 1;
            if (left <= 0) this.depth.delete(sessionId); else this.depth.set(sessionId, left);
            if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
        };

        try {
            if (ahead > 0) onQueued?.(ahead);
            await waitFor(previous, signal, this.maxWaitMs);
            const unlockRedis = await this.lockRedis(sessionId, signal);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                unlockRedis();
                finish();
            };
        } catch (err) {
            finish();
            throw err;
        }
    }

    // Cross-process part. No Redis (or Redis down) → in-process only.
    private async lockRedis(sessionId: string, signal?: AbortSignal): Promise<() => void> {
        const r = this.getRedis();
        if (!r) return () => {};
        const key = LOCK_PREFIX + sessionId;
        const token = randomUUID();
        const deadline = Date.now() + this.maxWaitMs;
        let delay = 100;
        try {
            while (!(await r.set(key, token, "PX", this.lockTtlMs, "NX"))) {
                if (signal?.aborted) throw abortError();
                if (Date.now() > deadline) throw new LaneTimeoutError();
                await sleep(delay, signal);
                delay = Math.min(1000, delay * 2);
            }
        } catch (err) {
            if (err instanceof LaneTimeoutError || isAbort(err)) throw err;
            if (!this.redisWarned) {
                this.redisWarned = true;
                console.warn(`[runtime] Redis lock unavailable (${err instanceof Error ? err.message : err}); chats are serialized per process only`);
            }
            return () => {};
        }
        const renew = setInterval(() => {
            r.eval(RENEW_SCRIPT, 1, key, token, String(this.lockTtlMs)).catch(() => {});
        }, Math.max(100, Math.floor(this.lockTtlMs / 3)));
        renew.unref?.();
        return () => {
            clearInterval(renew);
            r.eval(RELEASE_SCRIPT, 1, key, token).catch(() => {});
        };
    }
}

function abortError(): Error {
    const e = new Error("aborted");
    e.name = "AbortError";
    return e;
}

export function isAbort(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(t); reject(abortError()); };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

// Waits for `p`, unless the signal fires or the wait gets too long.
function waitFor(p: Promise<void>, signal: AbortSignal | undefined, maxMs: number): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { cleanup(); reject(new LaneTimeoutError()); }, maxMs);
        const onAbort = () => { cleanup(); reject(abortError()); };
        const cleanup = () => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); };
        signal?.addEventListener("abort", onAbort, { once: true });
        p.then(() => { cleanup(); resolve(); }, () => { cleanup(); resolve(); });
    });
}
