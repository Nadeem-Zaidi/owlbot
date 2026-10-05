import Redis from "ioredis";

// Optional Redis, shared by every backend process/server: rate limits and
// cross-instance messages (e.g. browser approvals). Without REDIS_URL the app
// falls back to in-memory state, which is fine for a single process.
let client: Redis | null | undefined;
let subscriber: Redis | null | undefined;

const url = () => process.env.REDIS_URL?.trim() || null;

const connect = (role: string) => {
    const r = new Redis(url()!, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
    });
    r.on("error", (err) => console.error(`[redis:${role}] ${err.message}`));
    return r;
};

export function redis(): Redis | null {
    if (client === undefined) client = url() ? connect("main") : null;
    return client;
}

// Pub/sub needs its own connection (a subscribed connection can't run other commands).
export function redisSubscriber(): Redis | null {
    if (subscriber === undefined) subscriber = url() ? connect("sub") : null;
    return subscriber;
}

export async function redisReady(): Promise<boolean> {
    const r = redis();
    if (!r) return true; // not configured → not required
    try {
        return (await r.ping()) === "PONG";
    } catch {
        return false;
    }
}

export async function closeRedis(): Promise<void> {
    await Promise.allSettled([client?.quit(), subscriber?.quit()]);
    client = subscriber = undefined;
}
