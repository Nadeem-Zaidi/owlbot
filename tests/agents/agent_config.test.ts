// Saving an agent: every rule the editor relies on.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeLLM, makeAgent, makeService, USER } from "./fakes";

const valid = (extra: Record<string, unknown> = {}) => ({ name: "Support", instructions: "Help customers.", ...extra });
const team = { id: "ws1", name: "Team", role: "owner" } as any;

describe("agent config", () => {
    const setup = () => makeService(new FakeLLM(() => ({ text: "ok" })));

    it("needs a name of at most 60 characters", async () => {
        const { service } = setup();
        await assert.rejects(service.create(USER, valid({ name: "  " })), /Name is required/);
        await assert.rejects(service.create(USER, valid({ name: "x".repeat(61) })), /at most 60/);
        assert.equal((await service.create(USER, valid())).name, "Support");
    });

    it("accepts only known built-in tools, including the Word & Excel pack", async () => {
        const { service } = setup();
        await assert.rejects(service.create(USER, valid({ builtin_tools: ["hack_the_planet"] })), /Unknown built-in tools: hack_the_planet/);
        const a = await service.create(USER, valid({ builtin_tools: ["search_knowledge_base", "documents", "documents"] }));
        assert.deepEqual(a.builtin_tools, ["search_knowledge_base", "documents"], "duplicates removed");
    });

    it("never allows local commands on a team agent", async () => {
        const { service } = setup();
        await assert.rejects(service.create(USER, valid({ builtin_tools: ["run_local_command"] }), team), /only for personal agents/);
        await service.create(USER, valid({ builtin_tools: ["run_local_command"] }));
    });

    it("checks the provider and model exist", async () => {
        const { service } = setup();
        await assert.rejects(service.create(USER, valid({ provider: "nope" })), /isn't configured/);
        await assert.rejects(service.create(USER, valid({ provider: "openai", model: "gpt-9000" })), /isn't available/);
        const a = await service.create(USER, valid({ provider: "openai", model: "fake-big" }));
        assert.equal(a.model, "fake-big");
        // No provider → no model either (falls back to the server default).
        assert.equal((await service.create(USER, valid({ model: "fake-big" }))).model, null);
    });

    it("refuses a personal API key on a team agent", async () => {
        const { service } = setup();
        await assert.rejects(service.create(USER, valid({ provider: "key:abc" }), team), /personal API key/);
    });

    it("validates the answer budget (limits)", async () => {
        const { service } = setup();
        await assert.rejects(service.create(USER, valid({ limits: { max_rounds: 0 } })), /Max tool rounds/);
        await assert.rejects(service.create(USER, valid({ limits: { max_rounds: 51 } })), /Max tool rounds/);
        await assert.rejects(service.create(USER, valid({ limits: { max_tokens: 500 } })), /Max tokens/);
        await assert.rejects(service.create(USER, valid({ limits: { max_minutes: 2.5 } })), /Max minutes/);
        const a = await service.create(USER, valid({ limits: { max_rounds: 10, max_minutes: "", max_tokens: null } }));
        assert.deepEqual(a.limits, { max_rounds: 10 });
    });

    it("checks instruction files", async () => {
        const { service } = setup();
        const file = (name: string, content = "Be brief.") => ({ name, content });
        await assert.rejects(service.create(USER, valid({ instruction_files: [file("rules.pdf")] })), /must be a \.md/);
        await assert.rejects(service.create(USER, valid({ instruction_files: [file("rules.md", "   ")] })), /is empty/);
        await assert.rejects(service.create(USER, valid({ instruction_files: [file("a.md"), file("A.md")] })), /Two instruction files/);
        await assert.rejects(service.create(USER, valid({ instruction_files: Array.from({ length: 11 }, (_, i) => file(`f${i}.md`)) })), /at most 10/);
        const a = await service.create(USER, valid({ instruction_files: [{ name: "C:\\docs\\style.md", content: "a\r\nb", enabled: false }] }));
        assert.deepEqual(a.instruction_files, [{ name: "style.md", content: "a\nb", enabled: false }], "path stripped, line endings normalised");
    });

    it("limits helper agents to 5, from the same space, never itself", async () => {
        const { service, repo } = setup();
        for (let i = 1; i <= 6; i++) repo.add(makeAgent({ id: `h${i}`, name: `Helper ${i}` }));
        repo.add(makeAgent({ id: "teamhelper", name: "Team helper", workspace_id: "ws1" }));
        await assert.rejects(service.create(USER, valid({ helper_agent_ids: ["h1", "h2", "h3", "h4", "h5", "h6"] })), /at most 5/);
        await assert.rejects(service.create(USER, valid({ helper_agent_ids: ["missing"] })), /helper agent wasn't found/);
        await assert.rejects(service.create(USER, valid({ helper_agent_ids: ["teamhelper"] })), /helper agent wasn't found/, "a team agent can't help a personal one");
        const a = await service.create(USER, valid({ helper_agent_ids: ["h1", "h1", "h2"] }));
        assert.deepEqual(a.helper_agent_ids, ["h1", "h2"]);
        await assert.rejects(service.update(USER, a.id, valid({ helper_agent_ids: [a.id] })), /can't ask itself/);
    });

    it("keeps only the user's own knowledge-base documents", async () => {
        const { service } = setup();
        const a = await service.create(USER, valid({ document_keys: [`${USER}/a.pdf`, "other-user/b.pdf", `${USER}/../x.pdf`, 42] }));
        assert.deepEqual(a.document_keys, [`${USER}/a.pdf`]);
    });

    it("trims starters to 6 of at most 200 characters", async () => {
        const { service } = setup();
        const a = await service.create(USER, valid({ starters: ["", ...Array.from({ length: 8 }, (_, i) => ` q${i} `), "x".repeat(300)] }));
        assert.equal(a.starters.length, 6);
        assert.equal(a.starters[0], "q0");
    });
});
