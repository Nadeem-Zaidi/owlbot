// Test doubles for agent regression tests: an in-memory agent store, a
// scripted model (FakeLLM) and a chat-session stub. No database, no network.
import { AgentService } from "../../src/service/agents/agent_service";
import type { ChatRunOptions, ILLM } from "../../src/interfaces/illm";
import type { AgentRow } from "../../src/repository/agent_repository";
import type { LLMMessage } from "../../src/types/llm_message";
import { runToolCalls } from "../../src/llms/tool_runner";

export const USER = "user-1";

export function makeAgent(p: Partial<AgentRow> & { id: string; name: string }): AgentRow {
    return {
        workspace_id: null, user_id: USER, icon: "🤖", description: "", instructions: "",
        provider: null, model: null, builtin_tools: [], document_keys: [], starters: [],
        instruction_files: [], skill_mode: "all", skill_ids: [], helper_agent_ids: [], limits: {},
        created_at: new Date(), updated_at: new Date(), ...p,
    };
}

// What the fake model does with one request: answer with text, or call
// tools (all in one turn) and then answer with `after(results)`.
export type Script = (ctx: { prompt: string; run?: ChatRunOptions; agentName: string }) =>
    | { text: string; delayMs?: number }
    | { tools: { name: string; args: Record<string, any> }[]; after: (results: { ok: boolean; value?: any; error?: string }[]) => string };

// A model that follows a script, records every request it gets, and runs
// tool calls through the real tool runner (so parallel batching, tool packs
// and helper agents behave exactly as in production).
export class FakeLLM implements ILLM {
    requests: { prompt: string; run?: ChatRunOptions; model?: string }[] = [];
    constructor(public script: Script, private name = "fake") {}

    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string, _key: string, signal: AbortSignal, model?: string, run?: ChatRunOptions): AsyncGenerator<LLMMessage, unknown, void> {
        const part = (messages[0]?.content as any[])?.[0];
        const prompt = typeof part?.text === "string" ? part.text : "";
        this.requests.push({ prompt, run, model });
        const agentName = /You are "([^"]+)"/.exec(run?.systemPrompt ?? "")?.[1] ?? "";
        const step = this.script({ prompt, run, agentName });
        let text: string;
        if ("text" in step) {
            if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
            text = step.text;
        } else {
            const toolset = run!.tools!;
            const results = yield* runToolCalls(toolset, step.tools, { userId, sessionId } as any, signal);
            text = step.after(results.map((r) => (r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error instanceof Error ? r.error.message : String(r.error) })));
        }
        yield { type: "message", role: "assistant", content: [{ type: "text", text }] } as LLMMessage;
        yield { content: "", isDone: true } as LLMMessage;
        return undefined;
    }

    async chat(): Promise<any> { throw new Error("not used"); }
    async summarizeChat(): Promise<string> { return ""; }
    getProvider() { return this.name; }
    getModel() { return `${this.name}-model`; }
    getModels() { return [`${this.name}-model`, `${this.name}-big`]; }
    supportsTools() { return true; }
}

// The parts of AgentRepository the agent service uses, kept in memory.
export class FakeAgentRepo {
    agents = new Map<string, AgentRow>();
    functions = new Map<string, any[]>();
    add(...rows: AgentRow[]) { for (const r of rows) this.agents.set(r.id, r); }
    async getAgent(id: string, _userId: string) { return this.agents.get(id) ?? null; }
    async listFunctions(id: string) { return this.functions.get(id) ?? []; }
    async listMcpServers() { return []; }
    async listCodeFunctions() { return []; }
    async listSchedules() { return []; }
    async createAgent(userId: string, input: any, workspaceId: string | null) {
        const row = makeAgent({ ...input, id: `agent-${this.agents.size + 1}`, user_id: userId, workspace_id: workspaceId });
        this.agents.set(row.id, row);
        return row;
    }
}

// Chat sessions: counts what was created and deleted (helpers must clean up).
export class FakeSessions {
    created: string[] = [];
    deleted: string[] = [];
    async createSession(_userId: string, _source: string, title: string) {
        const id = `s${this.created.length + 1}`;
        this.created.push(title);
        return { id };
    }
    async deleteSession(id: string) { this.deleted.push(id); }
}

// An AgentService wired to the fakes. `llm` answers for every agent.
export function makeService(llm: FakeLLM, opts: { localCommandTool?: boolean } = {}) {
    const repo = new FakeAgentRepo();
    const sessions = new FakeSessions();
    const stub: any = new Proxy({}, { get: () => () => undefined });
    const service = new AgentService({
        repo: repo as any,
        messageService: sessions as any,
        providers: new Map([["openai" as any, llm]]),
        defaultProvider: "openai" as any,
        kb: stub, vectorDb: stub, embed: stub,
        ...(opts.localCommandTool ? {
            localCommandTool: { name: "run_local_command", description: "", parameters: { type: "object", properties: {}, required: [] }, execute: async () => "ran" },
        } : {}),
    });
    return { service, repo, sessions };
}
