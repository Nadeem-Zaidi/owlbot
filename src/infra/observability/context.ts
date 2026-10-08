import { AsyncLocalStorage } from "node:async_hooks";

// What a log line is about: the HTTP request, the signed-in user and the
// chat turn. Set once (request middleware, auth, runtime) and picked up by
// every log line written while handling it — including plain console.log
// calls deep in providers and tools.
export type LogContext = {
    requestId?: string;
    userId?: string;
    runId?: string;
    sessionId?: string;
    channel?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

export function logContext(): LogContext | undefined {
    return storage.getStore();
}

// Runs `fn` with `fields` added to the current context.
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...fields }, fn);
}

// Adds fields to the current context in place (e.g. the user id once the
// token is verified, for the rest of that request).
export function setLogContext(fields: LogContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
}

// Iterates an async generator so that its code (and everything it awaits)
// runs with `fields` in the context. Plain `for await` would run it in the
// consumer's context instead.
export async function* iterateInContext<T>(fields: LogContext, gen: AsyncIterable<T>): AsyncGenerator<T, void, unknown> {
    const ctx = { ...storage.getStore(), ...fields };
    const it = gen[Symbol.asyncIterator]();
    try {
        while (true) {
            const r = await storage.run(ctx, () => it.next());
            if (r.done) return;
            yield r.value;
        }
    } finally {
        await storage.run(ctx, async () => { await it.return?.(); });
    }
}
