import { randomUUID } from "node:crypto";
import { redis, redisSubscriber } from "../../infra/redis";

// Commands an agent wants to run on the user's own computer, through the Owl
// Bot desktop app. The server never runs them: the request goes to the chat
// stream, the desktop app asks the user in a native dialog, runs it there and
// posts the result back to /api/local-commands/:id, which settles the
// waiting tool call.
//
// Pending requests live in this process. With several processes/servers the
// result may arrive at another one: requests are also kept in Redis and the
// result is relayed over a channel (same scheme as browser approvals).

export const LOCAL_SHELLS = ["powershell", "cmd", "bash"] as const;
export type LocalShell = (typeof LOCAL_SHELLS)[number];

export type LocalCommandRequest = {
    requestId: string;
    command: string;
    shell: LocalShell;
    cwd: string | null;
    reason: string;
    timeoutMinutes: number;
};

export type LocalCommandResult =
    | { status: "ran"; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }
    | { status: "denied" }
    | { status: "unavailable"; message: string }
    // No answer in time, or the chat was stopped.
    | { status: "expired" }
    | { status: "cancelled" };

// Time the user has to answer the dialog, on top of the command's own limit.
export const APPROVAL_WINDOW_MS = 10 * 60_000;
// Per stream, as posted by the desktop app (it caps output the same way).
export const MAX_POSTED_OUTPUT = 100_000;

const CHANNEL = "owlbot:local-command-results";
const key = (id: string) => `owlbot:local-command:${id}`;

type Pending = { userId: string; resolve: (r: LocalCommandResult) => void };

export class LocalCommandError extends Error {
    constructor(message: string, public readonly status = 400) {
        super(message);
    }
}

export class LocalCommandBroker {
    private pending = new Map<string, Pending>();
    private subscribed = false;

    // Sends the request (through `emit`) and waits for the desktop's answer.
    // Never throws: a timeout or Stop settles as expired/cancelled.
    async request(
        userId: string,
        input: Omit<LocalCommandRequest, "requestId">,
        emit: (event: { type: string } & Record<string, unknown>) => void,
        signal?: AbortSignal,
    ): Promise<LocalCommandResult> {
        const request: LocalCommandRequest = { requestId: randomUUID(), ...input };
        const waitMs = APPROVAL_WINDOW_MS + input.timeoutMinutes * 60_000 + 30_000;
        const result = new Promise<LocalCommandResult>((resolve) => {
            let settled = false;
            const finish = (r: LocalCommandResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                this.pending.delete(request.requestId);
                void redis()?.del(key(request.requestId)).catch(() => {});
                resolve(r);
            };
            const onAbort = () => finish({ status: "cancelled" });
            const timer = setTimeout(() => finish({ status: "expired" }), waitMs);
            if (signal?.aborted) return finish({ status: "cancelled" });
            signal?.addEventListener("abort", onAbort, { once: true });
            this.pending.set(request.requestId, { userId, resolve: finish });
            const r = redis();
            if (r) {
                this.ensureSubscribed();
                void r.set(key(request.requestId), JSON.stringify({ userId }), "PX", waitMs)
                    .catch((e) => console.error("[local-commands] couldn't store request:", e?.message));
            }
        });
        emit({ type: "local_command_request", request });
        return result;
    }

    // The desktop app's answer. Only the user who started the chat can answer.
    async answer(userId: string, requestId: string, body: unknown): Promise<{ ok: true }> {
        const result = parseResult(body);
        const local = this.pending.get(requestId);
        if (local) {
            if (local.userId !== userId) throw new LocalCommandError("This request has expired or was already answered", 404);
            local.resolve(result);
            return { ok: true };
        }
        const r = redis();
        const stored = r ? await r.get(key(requestId)).catch(() => null) : null;
        if (!stored || (JSON.parse(stored) as { userId: string }).userId !== userId) {
            throw new LocalCommandError("This request has expired or was already answered", 404);
        }
        await r!.publish(CHANNEL, JSON.stringify({ requestId, result }));
        return { ok: true };
    }

    // Requests waiting in this process (tests, shutdown).
    get size(): number {
        return this.pending.size;
    }

    private ensureSubscribed() {
        const sub = redisSubscriber();
        if (!sub || this.subscribed) return;
        this.subscribed = true;
        void sub.subscribe(CHANNEL).catch((e) => console.error("[local-commands] subscribe failed:", e?.message));
        sub.on("message", (channel, raw) => {
            if (channel !== CHANNEL) return;
            try {
                const { requestId, result } = JSON.parse(raw) as { requestId: string; result: LocalCommandResult };
                this.pending.get(requestId)?.resolve(result);
            } catch { /* ignore malformed */ }
        });
    }
}

const cap = (v: unknown) => (typeof v === "string" ? v : "").slice(0, MAX_POSTED_OUTPUT);

function parseResult(b: any): LocalCommandResult {
    switch (b?.status) {
        case "ran":
            return {
                status: "ran",
                exitCode: Number.isInteger(b.exitCode) ? b.exitCode : null,
                stdout: cap(b.stdout),
                stderr: cap(b.stderr),
                timedOut: b.timedOut === true,
                durationMs: Number.isFinite(b.durationMs) ? Math.max(0, Math.round(b.durationMs)) : 0,
            };
        case "denied":
            return { status: "denied" };
        case "unavailable":
            return { status: "unavailable", message: typeof b.message === "string" ? b.message.slice(0, 300) : "Local commands aren't available here." };
        default:
            throw new LocalCommandError('status must be "ran", "denied" or "unavailable"');
    }
}
