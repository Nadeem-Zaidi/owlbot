// Agents asking agents: answers, cleanup, loop/depth/call limits, parallel.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeLLM, makeAgent, makeService, USER, type Script } from "./fakes";

const signal = () => new AbortController().signal;

// A team: "Lead" can ask "Researcher" and "Writer"; scripts per agent name.
function team(scripts: Record<string, Script>) {
    const llm = new FakeLLM((ctx) => (scripts[ctx.agentName] ?? (() => ({ text: `${ctx.agentName} done` })))(ctx));
    const env = makeService(llm);
    env.repo.add(
        makeAgent({ id: "lead", name: "Lead", helper_agent_ids: ["res", "wri"] }),
        makeAgent({ id: "res", name: "Researcher", description: "Finds facts.", helper_agent_ids: ["lead", "deep"] }),
        makeAgent({ id: "wri", name: "Writer" }),
        makeAgent({ id: "deep", name: "Deep", helper_agent_ids: ["deeper"] }),
        makeAgent({ id: "deeper", name: "Deeper" }),
    );
    const run = (id: string, prompt = "go") => env.service.runOnce(env.repo.agents.get(id)!, USER, "chat", prompt, signal());
    return { ...env, llm, run };
}

describe("helper agents", () => {
    it("adds one ask_<name> tool per helper, marked parallel", async () => {
        const { service, repo } = team({});
        const run = await service.buildRun(repo.agents.get("lead")!);
        const asks = run.tools!.getAll().filter((t) => t.name.startsWith("ask_"));
        assert.deepEqual(asks.map((t) => t.name), ["ask_researcher", "ask_writer"]);
        assert.ok(asks.every((t) => t.parallel));
        assert.match(asks[0].description, /Finds facts\./);
        assert.match(run.systemPrompt!, /call their ask_ tools together/, "hint to ask several at once");
    });

    it("returns the helper's answer and deletes its throwaway chat", async () => {
        const t = team({
            Lead: () => ({ tools: [{ name: "ask_writer", args: { task: "Write a haiku", context: "about owls" } }], after: (r) => `Lead got: ${r[0].value.answer}` }),
            Writer: (ctx) => ({ text: `haiku for: ${ctx.prompt.replace(/\n/g, " ")}` }),
        });
        const r = await t.run("lead");
        assert.equal(r.text, "Lead got: haiku for: Write a haiku  --- Context: about owls");
        assert.equal(t.sessions.created.length, 1);
        assert.equal(t.sessions.deleted.length, 1, "helper chat cleaned up");
    });

    it("runs several helpers at the same time", async () => {
        const t = team({
            Lead: () => ({ tools: [{ name: "ask_researcher", args: { task: "a" } }, { name: "ask_writer", args: { task: "b" } }], after: (r) => r.map((x) => x.value.answer).join(" + ") }),
            Researcher: () => ({ text: "facts", delayMs: 300 }),
            Writer: () => ({ text: "prose", delayMs: 300 }),
        });
        const started = Date.now();
        const r = await t.run("lead");
        const took = Date.now() - started;
        assert.equal(r.text, "facts + prose", "answers stay in the order asked");
        assert.ok(took < 550, `took ${took}ms — one after another would be 600ms+`);
    });

    it("stops a loop back to an agent already working (A → B → A)", async () => {
        const t = team({
            Lead: () => ({ tools: [{ name: "ask_researcher", args: { task: "x" } }], after: (r) => String(r[0].value?.answer) }),
            Researcher: () => ({ tools: [{ name: "ask_lead", args: { task: "y" } }], after: (r) => (r[0].ok ? "looped!" : r[0].error!) }),
        });
        const r = await t.run("lead");
        assert.match(r.text, /already working on this request/);
    });

    it("stops work passed on more than 2 levels (A → B → C → D)", async () => {
        const t = team({
            Lead: () => ({ tools: [{ name: "ask_researcher", args: { task: "x" } }], after: (r) => String(r[0].value?.answer) }),
            Researcher: () => ({ tools: [{ name: "ask_deep", args: { task: "x" } }], after: (r) => String(r[0].value?.answer) }),
            Deep: () => ({ tools: [{ name: "ask_deeper", args: { task: "x" } }], after: (r) => (r[0].ok ? "too deep!" : r[0].error!) }),
        });
        const r = await t.run("lead");
        assert.match(r.text, /only be passed on 2 levels deep/);
    });

    it("caps helper calls at 6 per reply", async () => {
        const t = team({
            Lead: () => ({ tools: Array.from({ length: 7 }, () => ({ name: "ask_writer", args: { task: "x" } })), after: (r) => r.map((x) => (x.ok ? "ok" : x.error)).join("|") }),
        });
        const r = await t.run("lead");
        const parts = r.text.split("|");
        assert.equal(parts.filter((p) => p === "ok").length, 6);
        assert.match(parts[6], /already asked 6 times/);
    });

    it("fails clearly when the helper was deleted or the task is empty", async () => {
        const t = team({
            Lead: () => ({ tools: [{ name: "ask_writer", args: { task: "x" } }, { name: "ask_researcher", args: { task: "  " } }], after: (r) => r.map((x) => x.error).join("|") }),
        });
        const lead = t.repo.agents.get("lead")!;
        const run = await t.service.buildRun(lead);           // tools built while Writer existed…
        t.repo.agents.delete("wri");                           // …then Writer is deleted
        const out = await run.tools!.executeTool("ask_writer", { task: "x" }, { userId: USER } as any).catch((e) => e.message);
        assert.match(out, /no longer exists/);
        const empty = await run.tools!.executeTool("ask_researcher", { task: "  " }, { userId: USER } as any).catch((e) => e.message);
        assert.match(empty, /Give the agent a task/);
    });
});
