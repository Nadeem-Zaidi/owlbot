// Running a turn's tool calls: parallel batches, order, failures, packs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runToolCalls, withToolPacks } from "../../src/llms/tool_runner";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toolset(log: string[]) {
    const tool = (name: string, parallel: boolean, ms: number, opts: { fail?: boolean; pack?: string } = {}) => ({
        name, description: "", parallel, pack: opts.pack, parameters: { type: "object" as const, properties: {}, required: [] },
        execute: async () => {
            log.push(`start ${name}`);
            await sleep(ms);
            log.push(`end ${name}`);
            if (opts.fail) throw new Error(`${name} broke`);
            return `${name} ok`;
        },
    });
    const defs = [tool("read_a", true, 150), tool("read_b", true, 150), tool("read_bad", true, 150, { fail: true }), tool("write", false, 50), tool("make_excel", false, 10, { pack: "documents" })];
    return { getAll: () => defs, executeTool: (n: string) => defs.find((d) => d.name === n)!.execute() };
}

async function drain<T>(gen: AsyncGenerator<any, T>) {
    const events: any[] = [];
    for (;;) {
        const r = await gen.next();
        if (r.done) return { events, value: r.value };
        events.push(r.value);
    }
}
const signal = () => new AbortController().signal;

describe("tool runner", () => {
    it("runs parallel tools together and keeps results in order", async () => {
        const log: string[] = [];
        const t = Date.now();
        const { value } = await drain(runToolCalls(toolset(log), [{ name: "read_a", args: {} }, { name: "read_b", args: {} }, { name: "read_bad", args: {} }], {} as any, signal()));
        assert.ok(Date.now() - t < 300, "three 150ms tools in about 150ms");
        assert.deepEqual(value.map((r) => r.ok), [true, true, false], "one failure doesn't break the others");
        assert.equal((value[0] as any).value, "read_a ok");
    });

    it("runs any other tool alone, in the order the model chose", async () => {
        const log: string[] = [];
        await drain(runToolCalls(toolset(log), [{ name: "read_a", args: {} }, { name: "write", args: {} }, { name: "read_b", args: {} }], {} as any, signal()));
        assert.deepEqual(log, ["start read_a", "end read_a", "start write", "end write", "start read_b", "end read_b"]);
    });

    it("runs at most 6 tools at once", async () => {
        let running = 0, peak = 0;
        const defs = [{ name: "p", description: "", parallel: true, parameters: { type: "object" as const, properties: {}, required: [] }, execute: async () => { running++; peak = Math.max(peak, running); await sleep(20); running--; return 1; } }];
        const ts = { getAll: () => defs, executeTool: () => defs[0].execute() };
        await drain(runToolCalls(ts, Array.from({ length: 10 }, () => ({ name: "p", args: {} })), {} as any, signal()));
        assert.equal(peak, 6, "the agreed limit; change this test on purpose if the limit changes");
    });

    it("fails a call with bad arguments without running it", async () => {
        const log: string[] = [];
        const { value } = await drain(runToolCalls(toolset(log), [{ name: "write", args: {}, invalid: "bad JSON" }], {} as any, signal()));
        assert.equal(value[0].ok, false);
        assert.deepEqual(log, []);
    });

    it("sends heartbeats while slow tools run (keeps the stream alive)", async () => {
        const { events } = await drain(runToolCalls(toolset([]), [{ name: "read_a", args: {} }], {} as any, signal(), 40));
        assert.ok(events.some((e) => e.type === "heartbeat"));
    });

    it("hides opt-in pack tools unless the pack is on — and blocks calls to them", async () => {
        const ts = toolset([]);
        const off = withToolPacks(ts, []);
        assert.ok(!off.getAll().some((t) => t.name === "make_excel"));
        await assert.rejects(off.executeTool("make_excel", {}, {} as any), /switched off/);
        const on = withToolPacks(ts, ["documents"]);
        assert.equal(await on.executeTool("make_excel", {}, {} as any), "make_excel ok");
    });
});
