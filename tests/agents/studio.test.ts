// Agent Studio: how the canvas compiles into the workflow that runs it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileFlow, parseCanvas } from "../../src/core/studio/studio_canvas";
import { validateFlow } from "../../src/core/flows/flow_validate";

const agentNode = (id: string, name: string, y = 0) =>
    ({ id, type: "agent", position: { x: 300, y }, agent_id: `id-${id}`, instruction: "{{input}}", agent: { name, icon: "🤖", description: "", instructions: "" } });
const canvas = (edges: any[], extra: any[] = []) => parseCanvas({
    version: 1,
    nodes: [
        { id: "trig", type: "trigger", position: { x: 0, y: 0 }, trigger: { type: "manual" } },
        agentNode("jira", "Jira Agent"), agentNode("maximo", "Maximo Developer", 200),
        { id: "end", type: "end", position: { x: 600, y: 0 }, output: "J={{node.jira}} M={{node.maximo}}" },
        ...extra,
    ],
    edges,
}, "u1");
const idOf = (nodeId: string) => `id-${nodeId}`;

describe("studio compile", () => {
    it("keeps a plain chain as a chain", () => {
        const flow = compileFlow(canvas([{ from: "trig", to: "jira" }, { from: "jira", to: "maximo" }, { from: "maximo", to: "end" }]), idOf, null);
        assert.equal(flow.nodes.filter((n: any) => n.type === "agent").length, 2);
        assert.ok(!flow.nodes.some((n: any) => n.type === "parallel"));
    });

    it("turns agents side by side into one parallel step, and rewires {{node.<agent>}}", async () => {
        const flow = compileFlow(canvas([
            { from: "trig", to: "jira" }, { from: "trig", to: "maximo" }, { from: "jira", to: "end" }, { from: "maximo", to: "end" },
        ]), idOf, { projectName: "Demo" });
        const par = flow.nodes.find((n: any) => n.type === "parallel");
        assert.deepEqual(par.branches.map((b: any) => [b.id, b.label, b.agent_id]), [["jira", "Jira Agent", "id-jira"], ["maximo", "Maximo Developer", "id-maximo"]]);
        assert.equal(flow.nodes.find((n: any) => n.id === "end").output, `J={{node.${par.id}.jira}} M={{node.${par.id}.maximo}}`);
        await validateFlow(flow, async () => true);
    });

    it("explains what to fix when side-by-side agents don't meet again", () => {
        assert.throws(() => compileFlow(canvas([
            { from: "trig", to: "jira" }, { from: "trig", to: "maximo" }, { from: "jira", to: "end" }, { from: "maximo", to: "end2" },
        ], [{ id: "end2", type: "end", position: { x: 0, y: 0 }, output: "" }]), idOf, null), /same next step/);
        assert.throws(() => compileFlow(canvas([{ from: "trig", to: "jira" }, { from: "trig", to: "end" }, { from: "jira", to: "end" }]), idOf, null), /only agents can run side by side/);
    });

    it("rejects parts plugged into the wrong place", () => {
        const model = { id: "m", type: "model", position: { x: 0, y: 0 }, provider: "openai", model: null };
        assert.throws(() => canvas([{ from: "m", to: "end" }], [model]), /plug into an agent/);
        assert.throws(() => canvas([{ from: "trig", to: "jira" }], [model]), /isn't plugged into an agent/);
    });
});
