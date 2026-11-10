# Agent regression testing

Agents can break in four different ways, so they're tested in four layers.
Run the cheap layers on every change and the expensive ones before a release.

| Layer | What it catches | Cost | When |
|---|---|---|---|
| 1. Automated suite (`npm run test:agents`) | Logic bugs: rules, limits, tools, workflows | Free, ~2 s | Every change, before every commit |
| 2. Live smoke tests (real models) | Provider/API changes, tool calling, streaming | A few cents | Before every deploy |
| 3. Quality evals (fixed question set) | Answers getting worse after prompt/model changes | Under $1 | When prompts, skills or models change |
| 4. Manual release checklist | UI, channels, things only a human notices | 20 min | Before a release to clients |

---

## 1. Automated suite

```bash
npm run test:agents     # agents only
npm test                # every test in tests/
```

No database, no API keys, no network. `tests/agents/fakes.ts` provides:

- **FakeLLM** — a scripted model: answer with text, or call tools and then answer.
  Tool calls go through the real tool runner, so parallel batches, tool packs and
  helper agents behave exactly as in production. It records every request.
- **FakeAgentRepo** — agents in memory instead of Postgres.
- **FakeSessions** — counts chats created and deleted.

| File | Covers |
|---|---|
| `agent_config.test.ts` | Saving an agent: name, built-in tools (incl. Word & Excel pack), local commands never on team agents, provider/model checks, personal keys on team agents, limits ranges, instruction files, helper rules (max 5, same space, not itself), document scope, starters |
| `agent_run.test.ts` | What a run gets: system prompt (instructions, enabled files only, documents, injection guard), built-ins marked parallel, GET vs POST functions, local commands only in the owner's live desktop chat, Word & Excel pack, budget and skill scope, chosen model and fallback |
| `helper_agents.test.ts` | Agents asking agents: answer returned, throwaway chat deleted, helpers run at the same time, loop A→B→A blocked, depth > 2 blocked, 6 calls per reply, deleted helper, empty task |
| `tool_runner.test.ts` | Parallel tools together and in order, other tools alone, at most 6 at once, bad arguments never run, heartbeats, tool packs hide and block |
| `workflows.test.ts` | Saving: one Start, an End, no loops, nothing unreachable, both condition outcomes, agents exist, parallel 2–5 unique names. Running: chaining, conditions, router first match/Otherwise, approval pauses, failures, cancel, parallel timing/combining/`{{node.p.x}}`, `require_all` |
| `studio.test.ts` | Canvas → workflow: chains stay chains, side-by-side agents become a parallel step, `{{node.<agent>}}` rewired, helpful errors, parts plugged in wrong |

### Writing a new test

Every bug fix gets a test that fails before the fix and passes after it.

```ts
it("…what the user would notice…", async () => {
    const llm = new FakeLLM(({ agentName }) => agentName === "Lead"
        ? { tools: [{ name: "ask_writer", args: { task: "x" } }], after: (r) => r[0].value.answer }
        : { text: "done" });
    const { service, repo } = makeService(llm);
    repo.add(makeAgent({ id: "lead", name: "Lead", helper_agent_ids: ["w"] }), makeAgent({ id: "w", name: "Writer" }));
    const r = await service.runOnce(repo.agents.get("lead")!, USER, "s", "go", new AbortController().signal);
    assert.equal(r.text, "done");
});
```

### Check that a test can fail

A test that passes no matter what protects nothing. After writing one, break
the code it covers on purpose (e.g. change `MAX_HELPER_CALLS` from 6 to 7),
run the suite, confirm it fails, then restore the code with
`git checkout -- <file>`.

---

## 2. Live smoke tests (real models)

Run against the dev server with real keys, one model per provider you offer
(server models and one "your key" model). For each, check:

| # | Ask | Pass when |
|---|---|---|
| S1 | "hi" | Short answer, no tools called, says it's Owl Bot on the right model |
| S2 | "what model are you?" | Names the real provider and model (not "Claude" on DeepSeek) |
| S3 | A question your knowledge base answers | Calls `search_knowledge_base`, cites the document |
| S4 | Agent with 2 helpers: "ask both X and Y" | Both helper cards appear at the same time; final answer uses both |
| S5 | "Make an Excel of these numbers" with Word & Excel **off** | No file; answer explains or gives a table |
| S6 | Same with Word & Excel **on** | A downloadable `.xlsx` appears |
| S7 | Long agent task, press Stop | Stops quickly; the partial answer stays after reload |
| S8 | Agent with `max_rounds: 2` that needs many tools | Stops after 2 rounds with a final answer, no error |
| S9 | A workflow with a Parallel step | Both agents show running together; End has both answers |
| S10 | Same agent on WhatsApp/Telegram | Reply arrives, formatting readable, files delivered |

Record the token badge for S1 per model. A sudden jump (e.g. 3.5k → 6k for
"hi") means something new is being sent with every message.

---

## 3. Quality evals (answers getting worse)

Keep a fixed set of 20–30 real questions per important agent (Jira, Maximo,
clinic receptionist…) with what a good answer must contain:

| Question | Must | Must not |
|---|---|---|
| "Show KAN-4" | Calls the Jira tool; summary, status, assignee | Invent fields |
| "Write an attribute launch point for am_craft" | Uses the Maximo scripting skill; valid Jython | Mention unrelated skills |
| "What are your opening hours?" (clinic) | Hours from the documents | Guess when docs don't say |

Run the set before and after any change to instructions, skills, tools or the
model, and compare: tool used, required facts present, forbidden content
absent, tokens. Check the "must" items automatically (contains / tool-called);
for tone and quality, read the differences, or have a strong model grade
before vs after.

---

## 4. Manual release checklist

- [ ] `npm test` passes; backend `tsc` and frontend `tsc -b` pass
- [ ] Create, edit, duplicate and delete an agent (personal and team)
- [ ] Agent chat streams; tool cards and helper cards render; Stop works
- [ ] Model picker: right groups, "Your key" badge, keyboard works, choice remembered
- [ ] Studio: build trigger → 2 agents side by side → End; save; run; live status per agent
- [ ] Workflows: condition, router, approval (approve and reject), parallel step
- [ ] Schedules: "run now" delivers to the chat (and WhatsApp/email if on)
- [ ] Knowledge base: upload a file, ask about it
- [ ] Light and dark theme; sidebar collapsed and expanded; phone width
- [ ] After deploy: site loads over HTTPS, sign-in works on the current domain

---

## Make it automatic

Add a GitHub Action that runs `npm ci && npm test` on every push, and have
`deploy/ec2/deploy.sh` refuse to deploy when the suite fails. Then a broken
agent rule can't reach clients unnoticed.
