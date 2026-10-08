import { format } from "node:util";
import pino from "pino";
import { logContext } from "./context";

// One JSON object per line (LOG_FORMAT=json, the default in production), so
// logs can be searched by requestId, userId or runId in CloudWatch, Loki,
// Datadog… In development the familiar plain text stays (LOG_FORMAT=text).
//
// Secrets never reach the logs: known secret fields are redacted, and
// API keys / bot tokens / bearer tokens are masked inside message text.

const json = (process.env.LOG_FORMAT ?? (process.env.NODE_ENV === "production" ? "json" : "text")) === "json";

export const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { pid: process.pid, ...(process.env.WORKER_INDEX ? { worker: Number(process.env.WORKER_INDEX) } : {}) },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "msg",
    // Context fields on every line.
    mixin: () => logContext() ?? {},
    redact: {
        paths: ["authorization", "*.authorization", "headers.authorization", "apiKey", "*.apiKey", "token", "*.token", "botToken", "*.botToken", "password", "*.password", "secret", "*.secret"],
        censor: "[redacted]",
    },
});

// Masks secrets that end up inside free text (error messages, URLs).
const SECRET_PATTERNS: [RegExp, string][] = [
    [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, "sk-[redacted]"],
    [/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer [redacted]"],
    [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "[telegram-token]"],
    [/\/bot\d+:[A-Za-z0-9_-]+\//g, "/bot[redacted]/"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[redacted]"],
];

export function maskSecrets(text: string): string {
    let out = text;
    for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
    return out;
}

// Sends every console.log/info/warn/error through the logger, so the many
// existing log lines become structured and carry the request/run context.
// Text mode keeps console output as it was (with secrets masked).
let installed = false;
export function installConsoleBridge(): void {
    if (installed) return;
    installed = true;
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    if (!json) {
        for (const level of ["log", "info", "warn", "error"] as const) {
            console[level] = (...args: unknown[]) => original[level](maskSecrets(format(...args)));
        }
        return;
    }
    const emit = (level: "info" | "warn" | "error" | "debug") => (...args: unknown[]) => {
        const err = args.find((a) => a instanceof Error) as Error | undefined;
        const msg = maskSecrets(format(...args.filter((a) => a !== err)));
        if (err) logger[level]({ error: { type: err.name, message: maskSecrets(err.message), stack: maskSecrets(err.stack ?? "") } }, msg);
        else logger[level](msg);
    };
    console.log = emit("info");
    console.info = emit("info");
    console.warn = emit("warn");
    console.error = emit("error");
    console.debug = emit("debug");
}

export const logsAreJson = json;
