// Stops a model that keeps calling tools without getting anywhere — e.g. an
// agent guessing Jira keys PROJ-1, PROJ-2, PROJ-3… forever. Every provider's
// tool loop records each tool result here; once a limit is hit, the provider
// makes ONE last request with tools switched off and WRAP_UP appended, so the
// user gets an answer ("I couldn't find project PROJ — which project?")
// instead of a spinner that never ends.

export const MAX_TOOL_ROUNDS = 12;        // model requests that ran tools, per answer
export const MAX_FAILURES_IN_A_ROW = 4;   // failed tool calls back to back
export const MAX_SAME_TOOL_FAILURES = 5;  // failures of one tool, any arguments

// An agent's own budget for one answer (agent editor → Limits). Unset values
// use the defaults: MAX_TOOL_ROUNDS rounds, no time or token limit.
export type RunLimits = { maxRounds?: number; maxMinutes?: number; maxTokens?: number };
export const LIMIT_RANGES = {
    maxRounds: { min: 1, max: 50 },
    maxMinutes: { min: 1, max: 120 },
    maxTokens: { min: 10_000, max: 5_000_000 },
} as const;

// Tool results that report an error without throwing (MCP servers often do).
const ERROR_RESULT = /^\s*\{\s*"(error|isError)"\s*:\s*true\b|"isError"\s*:\s*true/;

export function looksFailed(result: string): boolean {
    return ERROR_RESULT.test(result.slice(0, 2000));
}

export class ToolLoopGuard {
    private rounds = 0;
    private failedInARow = 0;
    private failuresByTool = new Map<string, number>();
    private lastError = "";
    private stopReason: string | null = null;
    private tokens = 0;
    private readonly startedAt = Date.now();
    private readonly maxRounds: number;

    constructor(private limits: RunLimits = {}) {
        this.maxRounds = limits.maxRounds ?? MAX_TOOL_ROUNDS;
    }

    // Tokens billed for each model request of this answer (input + output).
    addTokens(n: number) {
        this.tokens += Math.max(0, n || 0);
    }

    // One tool call's outcome. `failed` comes from the provider (it threw);
    // results that merely contain an error are detected here too.
    record(name: string, result: string, failed = false) {
        if (failed || looksFailed(result)) {
            this.failedInARow++;
            const n = (this.failuresByTool.get(name) ?? 0) + 1;
            this.failuresByTool.set(name, n);
            this.lastError = errorText(result);
            if (this.failedInARow >= MAX_FAILURES_IN_A_ROW) this.stop(`the last ${this.failedInARow} tool calls all failed`);
            else if (n >= MAX_SAME_TOOL_FAILURES) this.stop(`${name} failed ${n} times`);
        } else {
            this.failedInARow = 0;
        }
    }

    // Call once after each model request that ran tools.
    endRound() {
        this.rounds++;
        const minutes = (Date.now() - this.startedAt) / 60_000;
        if (this.rounds >= this.maxRounds) this.stop(`the budget of ${this.maxRounds} rounds of tool calls was used`);
        else if (this.limits.maxMinutes && minutes >= this.limits.maxMinutes) this.stop(`the time budget of ${this.limits.maxMinutes} minutes was used`);
        else if (this.limits.maxTokens && this.tokens >= this.limits.maxTokens) this.stop(`the budget of ${this.limits.maxTokens.toLocaleString("en")} tokens was used`);
    }

    get shouldWrapUp(): boolean { return this.stopReason !== null; }

    // Instruction appended before the final, tool-less request.
    wrapUpInstruction(): string {
        return `[System: stop calling tools now — ${this.stopReason}.` +
            (this.lastError ? ` The last error was: ${this.lastError}.` : "") +
            " Reply to the user directly with what you found so far, say plainly what didn't work and why," +
            " and if something is missing (for example the right project key, issue key or name), ask the user for it." +
            " If you were working through steps, end with a short progress report: done, failed, and still to do." +
            " Don't guess more values and don't claim anything succeeded unless a tool result showed it.]";
    }

    private stop(reason: string) {
        if (!this.stopReason) this.stopReason = reason;
    }
}

function errorText(result: string): string {
    let msg = result;
    try {
        const parsed = JSON.parse(result);
        msg = typeof parsed?.message === "string" ? parsed.message : msg;
        // MCP errors arrive JSON-in-JSON; unwrap one level.
        try { const inner = JSON.parse(msg); if (typeof inner?.message === "string") msg = inner.message; } catch { /* plain text */ }
    } catch { /* not JSON */ }
    return msg.replace(/\s+/g, " ").slice(0, 300);
}
