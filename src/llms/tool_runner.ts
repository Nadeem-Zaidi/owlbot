import { ToolSource } from "../interfaces/illm";
import { LLMMessage } from "../types/llm_message";
import { ToolContext } from "../types/type";

// A quiet stream gets closed by proxies and browsers; while a tool runs for a
// long time (a command waiting for approval, a helper agent) the chat gets a
// small heartbeat event this often.
export const HEARTBEAT_MS = 20_000;

// How many tools of one turn may run at the same time.
export const MAX_PARALLEL_TOOLS = 6;

// Runs one tool inside a provider's loop. A provider can't yield while it is
// awaiting executeTool, so the tool gets `ctx.emit` instead: whatever it emits
// is yielded to the chat stream right away. Use with `yield*`, which returns
// the tool's result (or throws its error):
//
//   const output = yield* runTool(toolset, name, args, ctx, signal);
export async function* runTool(
    toolset: ToolSource,
    name: string,
    args: Record<string, any>,
    ctx: ToolContext,
    signal: AbortSignal,
    heartbeatMs = HEARTBEAT_MS,
): AsyncGenerator<LLMMessage, unknown, unknown> {
    const [result] = yield* runConcurrently([{ name, args }], toolset, ctx, signal, heartbeatMs);
    if (!result.ok) throw result.error;
    return result.value;
}

// One tool call the model made in a turn. `invalid`: the provider already
// knows it can't run (bad arguments) — it fails without running.
export type ToolCallRequest = { name: string; args: Record<string, any>; invalid?: string };
export type ToolCallResult = { ok: true; value: unknown } | { ok: false; error: unknown };

// The tools a run may use: tools of an opt-in pack (e.g. Word & Excel) only
// when the run turned that pack on. Hidden tools can't be called either.
export function withToolPacks(source: ToolSource, packs: string[] = []): ToolSource {
    const off = (t: { pack?: string }) => !!t.pack && !packs.includes(t.pack);
    if (!source.getAll().some(off)) return source;
    return {
        getAll: () => source.getAll().filter((t) => !off(t)),
        executeTool: async (name, args, ctx) => {
            const tool = source.getAll().find((t) => t.name === name);
            if (tool && off(tool)) throw new Error(`"${name}" is switched off for this chat`);
            return source.executeTool(name, args, ctx);
        },
    };
}

// True for tools marked `parallel` (no side effects, no user prompts), which
// may run at the same time as each other.
export function isParallelTool(toolset: ToolSource, name: string): boolean {
    return !!toolset.getAll().find((t) => t.name === name)?.parallel;
}

// Runs all the tool calls of one turn and returns their results in the same
// order. Consecutive parallel tools (e.g. asking several helper agents) run
// at the same time, up to MAX_PARALLEL_TOOLS; any other tool runs alone, in
// its place, so side effects keep the order the model chose.
//
//   const results = yield* runToolCalls(toolset, calls, ctx, signal);
export async function* runToolCalls(
    toolset: ToolSource,
    calls: ToolCallRequest[],
    ctx: ToolContext,
    signal: AbortSignal,
    heartbeatMs = HEARTBEAT_MS,
): AsyncGenerator<LLMMessage, ToolCallResult[], unknown> {
    const results: ToolCallResult[] = [];
    let i = 0;
    while (i < calls.length) {
        let j = i + 1;
        if (isParallelTool(toolset, calls[i].name)) {
            while (j < calls.length && j - i < MAX_PARALLEL_TOOLS && isParallelTool(toolset, calls[j].name)) j++;
        }
        results.push(...(yield* runConcurrently(calls.slice(i, j), toolset, ctx, signal, heartbeatMs)));
        i = j;
    }
    return results;
}

// Starts the calls together and forwards what they emit (plus heartbeats)
// until all of them have finished.
async function* runConcurrently(
    calls: ToolCallRequest[],
    toolset: ToolSource,
    ctx: ToolContext,
    signal: AbortSignal,
    heartbeatMs: number,
): AsyncGenerator<LLMMessage, ToolCallResult[], unknown> {
    const queue: LLMMessage[] = [];
    let wake: (() => void) | null = null;
    let pending = calls.length;
    const results: ToolCallResult[] = new Array(calls.length);

    const emit: ToolContext["emit"] = (event) => {
        queue.push(event as unknown as LLMMessage);
        wake?.();
    };
    calls.forEach((call, k) => {
        void Promise.resolve()
            .then(() => {
                if (call.invalid) throw new Error(call.invalid);
                return toolset.executeTool(call.name, call.args, { ...ctx, signal, emit });
            })
            .then((value) => { results[k] = { ok: true, value }; }, (error) => { results[k] = { ok: false, error }; })
            .finally(() => { pending--; wake?.(); });
    });

    for (;;) {
        while (queue.length) yield queue.shift()!;
        if (pending === 0) break;
        const timedOut = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(true), heartbeatMs);
            wake = () => { clearTimeout(timer); resolve(false); };
        });
        wake = null;
        if (timedOut && pending > 0 && !queue.length) yield { type: "heartbeat" } as unknown as LLMMessage;
    }
    return results;
}
