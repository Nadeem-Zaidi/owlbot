// Runs the API on every CPU core: one primary process forks N workers that
// share the port (Node's cluster module balances connections between them).
//   CLUSTER_WORKERS=8 node dist/cluster.js
// Worker 0 also runs the single-instance jobs (WhatsApp, scheduler).
// Shared state between workers (rate limits, browser approvals) needs REDIS_URL.
import cluster from "node:cluster";
import os from "node:os";

if (cluster.isPrimary) {
    const count = Math.max(1, Number(process.env.CLUSTER_WORKERS) || os.availableParallelism());
    if (count > 1 && !process.env.REDIS_URL) {
        console.warn("[cluster] REDIS_URL is not set: rate limits are per worker and browser approvals may fail. Set REDIS_URL for production.");
    }
    console.log(`[cluster] starting ${count} worker(s)`);
    let stopping = false;

    const fork = (index: number) => {
        const worker = cluster.fork({ WORKER_INDEX: String(index) });
        worker.on("exit", (code, signal) => {
            if (stopping) return;
            console.error(`[cluster] worker ${index} exited (${signal ?? code}) — restarting`);
            setTimeout(() => fork(index), 1000);
        });
    };
    for (let i = 0; i < count; i++) fork(i);

    const stop = (signal: NodeJS.Signals) => {
        if (stopping) return;
        stopping = true;
        console.log(`[cluster] ${signal} — stopping workers`);
        for (const w of Object.values(cluster.workers ?? {})) w?.process.kill(signal);
        // Workers drain their own connections (see main.ts); exit once all are gone.
        const check = setInterval(() => {
            if (!Object.values(cluster.workers ?? {}).some(Boolean)) { clearInterval(check); process.exit(0); }
        }, 200);
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
} else {
    require("./main");
}
