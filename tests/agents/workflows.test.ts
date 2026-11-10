// Workflows: what may be saved, and how runs move through the graph.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateFlow } from "../../src/core/flows/flow_validate";
import { FlowRunner } from "../../src/core/flows/flow_runner";

const P = { x: 0, y: 0 };
const start = { id: "start", type: "start", position: P };
const end = (id = "end", output = "{{previous}}") => ({ id, type: "end", position: P, output });
const agent = (id: string, agent_id: string, instruction = "{{previous}}") => ({ id, type: "agent", position: P, agent_id, instruction });
const edge = (from: string, to: string, branch?: string) => ({ from, to, ...(branch ? { branch } : {}) });
const exists = async () => true;

// Agents answer "<name>(<first line of prompt>)"; "Broken" fails; "Slow" takes 200ms.
const AGENTS: Record<string, { id: string; name: string; icon: string }> = Object.fromEntries(
    ["Writer", "Critic", "Broken", "Slow", "Fast"].map((n) => [n, { id: n, name: n, icon: "🤖" }]),
);

function runner(opts: { cancelled?: boolean } = {}) {
    const calls: string[] = [];
    let running = 0, peak = 0;
    const out: { ended: any; paused: any; saves: number } = { ended: null, paused: null, saves: 0 };
    const r = new FlowRunner({
        repo: {
            getRunStatus: async () => (opts.cancelled ? "cancelled" : "running"),
            saveFlowRun: async () => { out.saves++; },
            pauseRun: async (_id: number, trace: any, state: any) => { out.paused = { trace, state }; },
            endRun: async (_id: number, status: string, trace: any, output: any, error: any) => { out.ended = { status, trace, output, error }; },
        } as any,
        agentRepo: { getAgent: async (id: string) => AGENTS[id] ?? null } as any,
        messageService: { createSession: async () => ({ id: "s" }) } as any,
        agents: {
            runOnce: async (a: any, _u: string, _s: string, prompt: string) => {
                calls.push(a.name);
                running++; peak = Math.max(peak, running);
                await new Promise((res) => setTimeout(res, a.name === "Slow" ? 200 : 20));
                running--;
                return a.name === "Broken" ? { text: "", error: "boom" } : { text: `${a.name}(${prompt.split("\n")[0]})`, error: null };
            },
        } as any,
    });
    const go = async (raw: any, input = "cats") => {
        const flow = await validateFlow(raw, async (_k, id) => id in AGENTS);
        const result = await r.run(1, "u", "p", "Test", flow, r.initialState(input, flow), []);
        return { result, ...out, calls, peak: () => peak };
    };
    return go;
}

describe("workflow validation", () => {
    it("needs exactly one Start and at least one End", async () => {
        await assert.rejects(validateFlow({ nodes: [end()], edges: [] }, exists), /exactly one Start/);
        await assert.rejects(validateFlow({ nodes: [start, agent("a", "Writer")], edges: [edge("start", "a")] }, exists), /Add an End/);
    });

    it("rejects loops (no step may lead back)", async () => {
        const nodes = [start, agent("a", "Writer"), agent("b", "Critic"), end()];
        await assert.rejects(validateFlow({ nodes, edges: [edge("start", "a"), edge("a", "b"), edge("b", "a")] }, exists), /loop/);
        await assert.rejects(validateFlow({ nodes: [start, agent("a", "Writer"), { id: "c", type: "condition", position: P, mode: "rule", source: "previous", op: "contains", value: "x" }, end()],
            edges: [edge("start", "a"), edge("a", "c"), edge("c", "end", "true"), edge("c", "a", "false")] }, exists), /loop/);
    });

    it("rejects steps nobody can reach and half-connected branches", async () => {
        await assert.rejects(validateFlow({ nodes: [start, agent("a", "Writer"), agent("lost", "Critic"), end()], edges: [edge("start", "a"), edge("a", "end"), edge("lost", "end")] }, exists), /isn't connected/);
        const cond = { id: "c", type: "condition", position: P, mode: "rule", source: "previous", op: "contains", value: "x" };
        await assert.rejects(validateFlow({ nodes: [start, cond, end()], edges: [edge("start", "c"), edge("c", "end", "true")] }, exists), /both the Yes and the No/);
    });

    it("checks agents exist, and parallel steps have 2–5 agents with unique names", async () => {
        await assert.rejects(validateFlow({ nodes: [start, agent("a", "Nobody"), end()], edges: [edge("start", "a"), edge("a", "end")] }, async (_k, id) => id in AGENTS), /choose one of your agents/);
        const par = (branches: any[]) => ({ nodes: [start, { id: "p", type: "parallel", position: P, branches }, end()], edges: [edge("start", "p"), edge("p", "end")] });
        const b = (id: string, label = id) => ({ id, label, agent_id: "Writer", instruction: "" });
        await assert.rejects(validateFlow(par([b("x")]), exists), /at least two/);
        await assert.rejects(validateFlow(par(["a", "b", "c", "d", "e", "f"].map((x) => b(x))), exists), /at most 5/);
        await assert.rejects(validateFlow(par([b("x", "Same"), b("y", "same")]), exists), /two agents are called/);
    });
});

describe("workflow runs", () => {
    it("passes each agent's output to the next and ends with it", async () => {
        const r = await runner()({ nodes: [start, agent("a", "Writer", "write about {{input}}"), agent("b", "Critic"), end()], edges: [edge("start", "a"), edge("a", "b"), edge("b", "end")] });
        assert.equal(r.result, "succeeded");
        assert.equal(r.ended.output, "Critic(Writer(write about cats))");
    });

    it("takes the Yes / No branch from a rule", async () => {
        const flow = (value: string) => ({
            nodes: [start, agent("a", "Writer"), { id: "c", type: "condition", position: P, mode: "rule", source: "previous", op: "contains", value }, end("yes", "YES"), end("no", "NO")],
            edges: [edge("start", "a"), edge("a", "c"), edge("c", "yes", "true"), edge("c", "no", "false")],
        });
        assert.equal((await runner()(flow("cats"))).ended.output, "YES");
        assert.equal((await runner()(flow("dogs"))).ended.output, "NO");
    });

    it("routes to the first matching route, else Otherwise", async () => {
        const router = { id: "r", type: "router", position: P, mode: "rule", source: "input", routes: [
            { id: "big", label: "Big", when: { match: "all", rules: [{ op: "number_gt", value: "1000" }] } },
            { id: "mid", label: "Mid", when: { match: "all", rules: [{ op: "number_gt", value: "100" }] } },
        ] };
        const flow = { nodes: [start, router, end("e1", "BIG"), end("e2", "MID"), end("e3", "SMALL")],
            edges: [edge("start", "r"), edge("r", "e1", "route:big"), edge("r", "e2", "route:mid"), edge("r", "e3", "default")] };
        assert.equal((await runner()(flow, "₹5,000")).ended.output, "BIG");
        assert.equal((await runner()(flow, "₹500")).ended.output, "MID");
        assert.equal((await runner()(flow, "₹50")).ended.output, "SMALL");
    });

    it("pauses at an approval and saves where it is", async () => {
        const r = await runner()({ nodes: [start, { id: "ok", type: "approval", position: P, message: "Approve {{input}}?", notify: false }, end()], edges: [edge("start", "ok"), edge("ok", "end", "approved")] });
        assert.equal(r.result, "waiting");
        assert.equal(r.paused.state.current, "ok");
        assert.equal(r.ended, null);
    });

    it("fails the run when an agent fails, or was deleted", async () => {
        const r = await runner()({ nodes: [start, agent("a", "Broken"), end()], edges: [edge("start", "a"), edge("a", "end")] });
        assert.equal(r.result, "failed");
        assert.match(r.ended.error, /boom/);
    });

    it("stops a run that was cancelled", async () => {
        const r = await runner({ cancelled: true })({ nodes: [start, agent("a", "Writer"), end()], edges: [edge("start", "a"), edge("a", "end")] });
        assert.equal(r.result, "cancelled");
        assert.deepEqual(r.calls, []);
    });

    it("runs a parallel step's agents at the same time and combines their answers", async () => {
        const par = { id: "p", type: "parallel", position: P, require_all: true, branches: [
            { id: "s", label: "Slow one", agent_id: "Slow", instruction: "{{input}}" },
            { id: "f", label: "Fast one", agent_id: "Fast", instruction: "{{input}}" },
        ] };
        const go = runner();
        const t = Date.now();
        const r = await go({ nodes: [start, par, end("end", "S={{node.p.s}} F={{node.p.f}}")], edges: [edge("start", "p"), edge("p", "end")] });
        assert.equal(r.result, "succeeded");
        assert.equal(r.peak(), 2);
        assert.ok(Date.now() - t < 350, "about as long as the slowest agent");
        assert.equal(r.ended.output, "S=Slow(cats) F=Fast(cats)");
        assert.match(r.ended.trace.find((e: any) => e.node_id === "p").output, /^## Slow one\n\nSlow\(cats\)\n\n## Fast one/);
    });

    it("parallel: one failed agent fails the run, unless set to continue", async () => {
        const flow = (require_all: boolean) => ({
            nodes: [start, { id: "p", type: "parallel", position: P, require_all, branches: [
                { id: "a", label: "Works", agent_id: "Writer", instruction: "" }, { id: "b", label: "Fails", agent_id: "Broken", instruction: "" },
            ] }, end()],
            edges: [edge("start", "p"), edge("p", "end")],
        });
        const strict = await runner()(flow(true));
        assert.equal(strict.result, "failed");
        assert.match(strict.ended.error, /Fails: boom/);
        const lenient = await runner()(flow(false));
        assert.equal(lenient.result, "succeeded");
        assert.match(lenient.ended.output, /## Fails\n\n\(No answer — boom\)/);
    });
});
