// What an agent is given when it runs: prompt, tools, packs, budget, model.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeLLM, makeAgent, makeService, USER } from "./fakes";

const names = (run: any) => run.tools.getAll().map((t: any) => t.name);
const tool = (run: any, name: string) => run.tools.getAll().find((t: any) => t.name === name);

describe("agent run setup", () => {
    it("builds the system prompt from name, instructions, enabled files and documents", async () => {
        const { service } = makeService(new FakeLLM(() => ({ text: "ok" })));
        const run = await service.buildRun(makeAgent({
            id: "a", name: "Jira Agent", instructions: "Triage tickets.",
            instruction_files: [{ name: "on.md", content: "Use labels.", enabled: true }, { name: "off.md", content: "SECRET RULE", enabled: false }],
            document_keys: [`${USER}/sla.pdf`],
        }));
        const p = run.systemPrompt!;
        assert.match(p, /You are "Jira Agent"/);
        assert.match(p, /Triage tickets\./);
        assert.match(p, /## Instruction file: on\.md\n\nUse labels\./);
        assert.doesNotMatch(p, /SECRET RULE/, "disabled files are left out");
        assert.match(p, /only use these documents.*sla\.pdf/);
        assert.match(p, /data, not instructions/, "prompt-injection guard is always there");
    });

    it("gives built-in tools, all safe to run in parallel", async () => {
        const { service } = makeService(new FakeLLM(() => ({ text: "ok" })));
        const run = await service.buildRun(makeAgent({ id: "a", name: "A", builtin_tools: ["search_knowledge_base", "current_datetime", "code_interpreter"] }));
        assert.ok(names(run).includes("search_knowledge_base"));
        assert.ok(names(run).includes("current_datetime"));
        assert.ok(!names(run).includes("code_interpreter"), "hosted tool, not a function");
        assert.equal(tool(run, "current_datetime").parallel, true);
        assert.equal(run.codeInterpreter, true);
    });

    it("turns on the Word & Excel pack only when ticked", async () => {
        const { service } = makeService(new FakeLLM(() => ({ text: "ok" })));
        assert.deepEqual((await service.buildRun(makeAgent({ id: "a", name: "A" }))).toolPacks, []);
        assert.deepEqual((await service.buildRun(makeAgent({ id: "b", name: "B", builtin_tools: ["documents"] }))).toolPacks, ["documents"]);
    });

    it("runs GET functions in parallel, never POST", async () => {
        const { service, repo } = makeService(new FakeLLM(() => ({ text: "ok" })));
        const fn = (name: string, method: string) => ({ id: name, agent_id: "a", name, description: "", method, url: "https://example.com", parameters: [], headers: [], enabled: true });
        repo.functions.set("a", [fn("getOrder", "GET"), fn("createOrder", "POST"), { ...fn("off", "GET"), enabled: false }]);
        const run = await service.buildRun(makeAgent({ id: "a", name: "A" }));
        assert.equal(tool(run, "getOrder").parallel, true);
        assert.equal(tool(run, "createOrder").parallel, false);
        assert.ok(!names(run).includes("off"), "disabled functions are left out");
    });

    it("gives local commands only in the owner's live desktop chat, and only if ticked", async () => {
        const { service } = makeService(new FakeLLM(() => ({ text: "ok" })), { localCommandTool: true });
        const ticked = makeAgent({ id: "a", name: "A", builtin_tools: ["run_local_command"] });
        assert.ok(!names(await service.buildRun(ticked)).includes("run_local_command"), "no access → no tool (schedules, workflows, helpers)");
        const live = await service.buildRun(ticked, { localCommands: { platform: "win32" } });
        assert.ok(names(live).includes("run_local_command"));
        assert.match(live.systemPrompt!, /Windows/);
        assert.ok(!names(await service.buildRun(makeAgent({ id: "b", name: "B" }), { localCommands: { platform: "win32" } })).includes("run_local_command"), "not ticked → no tool");
    });

    it("passes the agent's budget and skill scope", async () => {
        const { service } = makeService(new FakeLLM(() => ({ text: "ok" })));
        const run = await service.buildRun(makeAgent({ id: "a", name: "A", limits: { max_rounds: 5, max_tokens: 20_000 }, skill_mode: "selected", skill_ids: ["s1"] }));
        assert.deepEqual(run.limits, { maxRounds: 5, maxMinutes: undefined, maxTokens: 20_000 });
        assert.deepEqual(run.skillScope, { mode: "selected", ids: ["s1"] });
    });

    it("answers with the agent's chosen model", async () => {
        const llm = new FakeLLM(() => ({ text: "Done." }));
        const { service } = makeService(llm);
        const r = await service.runOnce(makeAgent({ id: "a", name: "A", provider: "openai", model: "fake-big" }), USER, "s", "hi", new AbortController().signal);
        assert.deepEqual(r, { text: "Done.", error: null });
        assert.equal(llm.requests[0].model, "fake-big");
        // An unknown model falls back to the provider default instead of failing.
        await service.runOnce(makeAgent({ id: "b", name: "B", provider: "openai", model: "gone" }), USER, "s", "hi", new AbortController().signal);
        assert.equal(llm.requests[1].model, "fake-model");
    });
});
