import { ToolSource } from "../interfaces/illm";
import { LLMMessage } from "../types/llm_message";
import { ToolContext } from "../types/type";

// A quiet stream gets closed by proxies and browsers; while a tool runs for a
// long time (a command waiting for approval, a helper agent) the chat gets a
// small heartbeat event this often.
export const HEARTBEAT_MS = 20_000;

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
    const queue: LLMMessage[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let value: unknown;
    let error: unknown;
    let failed = false;

    const emit: ToolContext["emit"] = (event) => {
        queue.push(event as unknown as LLMMessage);
        wake?.();
    };
    void Promise.resolve()
        .then(() => toolset.executeTool(name, args, { ...ctx, signal, emit }))
        .then((v) => { value = v; }, (e) => { error = e; failed = true; })
        .finally(() => { done = true; wake?.(); });

    for (;;) {
        while (queue.length) yield queue.shift()!;
        if (done) break;
        const timedOut = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(true), heartbeatMs);
            wake = () => { clearTimeout(timer); resolve(false); };
        });
        wake = null;
        if (timedOut && !done && !queue.length) yield { type: "heartbeat" } as unknown as LLMMessage;
    }
    if (failed) throw error;
    return value;
}
