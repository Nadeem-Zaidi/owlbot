import { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis } from "./redis";

const num = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
};

// Signed-in users are limited per account (fair across devices/NAT);
// anonymous calls per IP.
const keyFor = (req: Request) => (req.user?.uid ? `u:${req.user.uid}` : `ip:${ipKeyGenerator(req.ip ?? "")}`);

function store(prefix: string) {
    const r = redis();
    // Counters in Redis are shared by every process/server; without Redis each
    // process counts on its own (fine for one process).
    return r ? new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (command: string, ...args: string[]) => r.call(command, ...args) as any }) : undefined;
}

export function apiRateLimit(): RequestHandler {
    return rateLimit({
        windowMs: 60_000,
        limit: num("RATE_LIMIT_PER_MINUTE", 600),
        keyGenerator: keyFor,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        store: store("api"),
        message: { message: "Too many requests — slow down and try again in a minute." },
    });
}

// Model calls are the expensive part (seconds and real money each), so they
// get their own, much lower limit.
export function chatRateLimit(): RequestHandler {
    return rateLimit({
        windowMs: 60_000,
        limit: num("CHAT_RATE_LIMIT_PER_MINUTE", 30),
        keyGenerator: keyFor,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        store: store("chat"),
        message: { message: "You're sending messages too fast — wait a moment and try again." },
    });
}
