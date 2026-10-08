import { monitorEventLoopDelay } from "node:perf_hooks";

// A small Prometheus metrics registry (counters, gauges, histograms) with
// the text format for GET /metrics. No dependency; label values are kept to
// small fixed sets (never user ids or free text) so series stay bounded.

type Labels = Record<string, string | number | boolean | undefined>;

const key = (labels: Labels = {}) =>
    Object.keys(labels).sort().filter((k) => labels[k] !== undefined).map((k) => `${k}="${String(labels[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`).join(",");
const fmt = (name: string, labelKey: string, value: number) => `${name}${labelKey ? `{${labelKey}}` : ""} ${Number.isFinite(value) ? value : 0}`;

interface Metric {
    readonly name: string;
    render(): string[];
}

// Caps distinct label combinations per metric, so a bug can't explode memory.
const MAX_SERIES = 2_000;

export class Counter implements Metric {
    private values = new Map<string, number>();
    constructor(readonly name: string, readonly help: string) {}
    inc(labels: Labels = {}, by = 1): void {
        const k = key(labels);
        if (!this.values.has(k) && this.values.size >= MAX_SERIES) return;
        this.values.set(k, (this.values.get(k) ?? 0) + by);
    }
    get(labels: Labels = {}): number {
        return this.values.get(key(labels)) ?? 0;
    }
    render(): string[] {
        return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...[...this.values].map(([k, v]) => fmt(this.name, k, v))];
    }
}

export class Gauge implements Metric {
    private values = new Map<string, number>();
    // Read at scrape time instead of being set.
    constructor(readonly name: string, readonly help: string, private collect?: () => number | Array<[Labels, number]>) {}
    set(value: number, labels: Labels = {}): void {
        this.values.set(key(labels), value);
    }
    render(): string[] {
        const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
        if (this.collect) {
            const v = this.collect();
            if (typeof v === "number") lines.push(fmt(this.name, "", v));
            else for (const [labels, value] of v) lines.push(fmt(this.name, key(labels), value));
        }
        for (const [k, v] of this.values) lines.push(fmt(this.name, k, v));
        return lines;
    }
}

export class Histogram implements Metric {
    private series = new Map<string, { counts: number[]; sum: number; count: number }>();
    constructor(readonly name: string, readonly help: string, private buckets: number[]) {}
    observe(value: number, labels: Labels = {}): void {
        const k = key(labels);
        let s = this.series.get(k);
        if (!s) {
            if (this.series.size >= MAX_SERIES) return;
            s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
            this.series.set(k, s);
        }
        this.buckets.forEach((b, i) => { if (value <= b) s!.counts[i]++; });
        s.sum += value;
        s.count++;
    }
    // Times an async function (seconds).
    async time<T>(labels: Labels, fn: () => Promise<T>): Promise<T> {
        const start = process.hrtime.bigint();
        try { return await fn(); } finally { this.observe(Number(process.hrtime.bigint() - start) / 1e9, labels); }
    }
    render(): string[] {
        const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
        for (const [k, s] of this.series) {
            const sep = k ? `${k},` : "";
            this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{${sep}le="${b}"} ${s.counts[i]}`));
            lines.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
            lines.push(fmt(`${this.name}_sum`, k, s.sum), fmt(`${this.name}_count`, k, s.count));
        }
        return lines;
    }
}

const registry: Metric[] = [];
const register = <M extends Metric>(m: M): M => { registry.push(m); return m; };

export function renderMetrics(): string {
    return registry.flatMap((m) => m.render()).join("\n") + "\n";
}

// For live values owned by other modules (active runs, sockets, …).
export function registerGauge(name: string, help: string, collect: () => number | Array<[Labels, number]>): void {
    if (registry.some((m) => m.name === name)) return;
    register(new Gauge(name, help, collect));
}

const SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

// ── the app's metrics ──
export const metrics = {
    httpRequests: register(new Counter("owl_http_requests_total", "HTTP requests by route and status class")),
    httpDuration: register(new Histogram("owl_http_request_duration_seconds", "HTTP request duration (streams: until the stream ends)", SECONDS)),
    turns: register(new Counter("owl_turns_total", "Chat turns by channel, target (chat/agent/native) and outcome")),
    turnDuration: register(new Histogram("owl_turn_duration_seconds", "Chat turn duration, from start to last chunk", SECONDS)),
    laneWait: register(new Histogram("owl_turn_queue_wait_seconds", "Time a turn waited behind an earlier turn in the same chat", SECONDS)),
    laneRejected: register(new Counter("owl_turn_queue_rejected_total", "Turns rejected because the chat's queue was full or waited too long")),
    llmTokens: register(new Counter("owl_llm_tokens_total", "Model tokens by provider, kind (chat/title/compaction), direction and BYOK")),
    llmErrors: register(new Counter("owl_llm_errors_total", "Model errors reported in turns, by provider and code")),
    compactions: register(new Counter("owl_context_compactions_total", "Context engine summaries of older messages, by outcome")),
    memorySaves: register(new Counter("owl_memory_saves_total", "Memories saved from chats, by result")),
    channelMessages: register(new Counter("owl_channel_messages_total", "Messages on messaging apps, by channel and direction")),
    eventsPublished: register(new Counter("owl_events_published_total", "Live events published, by type")),
    skillLoads: register(new Counter("owl_skill_loads_total", "Skills loaded by the assistant")),
    flowNodes: register(new Counter("owl_flow_nodes_total", "Workflow nodes executed, by type and outcome")),
};

// ── process ──
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
registerGauge("owl_process_resident_memory_bytes", "Resident memory", () => process.memoryUsage().rss);
registerGauge("owl_process_heap_used_bytes", "V8 heap in use", () => process.memoryUsage().heapUsed);
registerGauge("owl_process_uptime_seconds", "Process uptime", () => Math.round(process.uptime()));
registerGauge("owl_event_loop_delay_p99_seconds", "Event loop delay (99th percentile since the last scrape)", () => {
    const v = loopDelay.percentile(99) / 1e9;
    loopDelay.reset();
    return v;
});
