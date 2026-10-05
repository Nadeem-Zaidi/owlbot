import { IVectorDb } from "../../interfaces/vectordb/ivector";
import { ChatRunOptions, ILLM } from "../../interfaces/illm";
import { NativeAgentInput, NativeAgentRepository, NativeAgentRow, NativeMcpServer, NativeProvider } from "../../repository/native_agent_repository";
import { UsageRepository } from "../../repository/usage_repository";
import { EmbeddingProvider, createVectorSearchTool } from "../../tools/vector_tool";
import { LLMMessage } from "../../types/llm_message";
import { UsageTrackingLLM, usageIncrement } from "../../llms/usage_tracking";
import { MessageService } from "../message_service";
import { AgentError, AgentService, codeFunctionDto, functionDto } from "../agents/agent_service";
import { assertPublicUrl } from "../agents/url_guard";
import { MAX_TOOL_OUTPUT_CHARS, callHttpFunction, codeFunctionTool, decryptCodeSecrets, httpFunctionTool } from "../agents/agent_tools";
import { codeFunctionsEnabled, isOwner } from "../agents/owner";
import { runPython } from "../../protos/client";
import { AgentCodeFunctionRow, AgentFunctionRow } from "../../repository/agent_repository";
import { ToolDefinition } from "../../types/type";
import { ApprovalAnswer, ApprovalRequest, NativeAgentSpec, NativeBackend, NativeTool, cancelAnswer } from "./native_types";
import { redis, redisSubscriber } from "../../infra/redis";

// With several processes/servers, the answer may arrive at a different one
// than the process streaming the chat: pending approvals are kept in Redis and
// answers are relayed over this channel.
const APPROVAL_CHANNEL = "owlbot:approval-answers";
const approvalKey = (id: string) => `owlbot:approval:${id}`;

type Deps = {
    repo: NativeAgentRepository;
    backends: Map<NativeProvider, NativeBackend>;
    messageService: MessageService;
    usage: UsageRepository;
    vectorDb: IVectorDb;
    embed: EmbeddingProvider;
    // Regular agents' service: provider agents reuse its function validation.
    agents: AgentService;
};

const KB_TOOL = "search_knowledge_base";
// How long the hosted browser waits for the user to allow a site / sign in.
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

type PendingApproval = { userId: string; request: ApprovalRequest; resolve: (a: ApprovalAnswer) => void };

const MCP_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_MCP_SERVERS = 10;

const str = (v: unknown, max: number, field: string, required = false): string => {
    const s = typeof v === "string" ? v.trim() : "";
    if (required && !s) throw new AgentError(`${field} is required`);
    if (s.length > max) throw new AgentError(`${field} must be at most ${max} characters`);
    return s;
};

// Agents that live in the provider's own agent platform (Claude Managed
// Agents / OpenAI Agents API). Separate from the regular agents, which run
// in this server's own loop. Only the provider the user has switched on is
// usable; the other provider's agents are kept but disabled.
export class NativeAgentService {
    // Browser approvals waiting for the user (one per open request).
    private approvals = new Map<string, PendingApproval>();
    private subscribed = false;

    constructor(private deps: Deps) {}

    // Answers relayed from other processes for approvals open in this one.
    private ensureSubscribed() {
        const sub = redisSubscriber();
        if (!sub || this.subscribed) return;
        this.subscribed = true;
        void sub.subscribe(APPROVAL_CHANNEL).catch((e) => console.error("[native-agents] subscribe failed:", e?.message));
        sub.on("message", (channel, raw) => {
            if (channel !== APPROVAL_CHANNEL) return;
            try {
                const { requestId, answer } = JSON.parse(raw) as { requestId: string; answer: ApprovalAnswer };
                this.approvals.get(requestId)?.resolve(answer);
            } catch { /* ignore malformed */ }
        });
    }

    // Waits for the user's answer; cancels on timeout or when the chat stops.
    waitForApproval(userId: string, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (a: ApprovalAnswer) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                this.approvals.delete(request.requestId);
                void redis()?.del(approvalKey(request.requestId)).catch(() => {});
                resolve(a);
            };
            const onAbort = () => finish(cancelAnswer(request));
            const timer = setTimeout(() => finish(cancelAnswer(request)), APPROVAL_TIMEOUT_MS);
            if (signal.aborted) return finish(cancelAnswer(request));
            signal.addEventListener("abort", onAbort, { once: true });
            this.approvals.set(request.requestId, { userId, request, resolve: finish });
            const r = redis();
            if (r) {
                this.ensureSubscribed();
                void r.set(approvalKey(request.requestId), JSON.stringify({ userId, request }), "PX", APPROVAL_TIMEOUT_MS)
                    .catch((e) => console.error("[native-agents] couldn't store approval:", e?.message));
            }
        });
    }

    // The user's answer from the chat. Sign-in values go straight to OpenAI;
    // they are never stored or logged here.
    async answerApproval(userId: string, requestId: string, body: any): Promise<{ ok: true }> {
        let pending: { userId: string; request: ApprovalRequest; resolve: (a: ApprovalAnswer) => void } | undefined = this.approvals.get(requestId);
        const r = redis();
        if (!pending && r) {
            // Open in another process: validate here, relay the answer there.
            const stored = await r.get(approvalKey(requestId)).catch(() => null);
            if (stored) {
                const { userId: owner, request } = JSON.parse(stored) as { userId: string; request: ApprovalRequest };
                pending = { userId: owner, request, resolve: (answer) => { void r.publish(APPROVAL_CHANNEL, JSON.stringify({ requestId, answer })); } };
            }
        }
        if (!pending || pending.userId !== userId) throw new AgentError("This request has expired or was already answered", 404);
        const req = pending.request;
        if (req.kind === "origin") {
            const decision = body?.decision;
            if (decision !== "approve" && decision !== "deny" && decision !== "cancel") throw new AgentError("Choose allow or deny");
            pending.resolve({ kind: "origin", decision });
            return { ok: true };
        }
        if (body?.cancel === true) {
            pending.resolve({ kind: "signin", action: "cancel" });
            return { ok: true };
        }
        const known = new Map(req.fields.map((f) => [f.id, f]));
        const raw: any[] = Array.isArray(body?.fields) ? body.fields : [];
        if (raw.length > 6) throw new AgentError("Too many fields");
        const fields = raw.map((f) => {
            const id = String(f?.field_id ?? "");
            if (!known.has(id)) throw new AgentError("Unknown field");
            const value = typeof f?.value === "string" ? f.value : "";
            if (value.length > 4000) throw new AgentError("Value is too long");
            return { field_id: id, value };
        });
        let selected: string | null = null;
        if (req.options.length) {
            selected = typeof body?.selected_option === "string" ? body.selected_option : "";
            const option = req.options.find((o) => o.id === selected);
            if (!option) throw new AgentError("Choose a sign-in method");
            const allowed = new Set(option.field_ids);
            if (fields.some((f) => !allowed.has(f.field_id))) throw new AgentError("A field doesn't belong to that sign-in method");
        }
        const missing = req.fields.filter((f) => f.required && (!req.options.length || req.options.find((o) => o.id === selected)?.field_ids.includes(f.id)))
            .filter((f) => !fields.some((x) => x.field_id === f.id && x.value));
        if (missing.length) throw new AgentError(`Fill in ${missing.map((m) => m.label).join(", ")}`);
        pending.resolve({ kind: "signin", action: "submit", fields, selected_option: selected });
        return { ok: true };
    }

    private backend(provider: string): NativeBackend {
        const b = this.deps.backends.get(provider as NativeProvider);
        if (!b) throw new AgentError(`${provider === "anthropic" ? "Claude" : provider === "openai" ? "ChatGPT" : provider} isn't configured on this server`);
        return b;
    }

    // The switched-on provider, falling back to the first configured one.
    async activeProvider(userId: string): Promise<NativeProvider | null> {
        const saved = await this.deps.repo.activeProvider(userId);
        if (saved && this.deps.backends.has(saved)) return saved;
        return [...this.deps.backends.keys()][0] ?? null;
    }

    async overview(userId: string, email?: string) {
        const active = await this.activeProvider(userId);
        const agents = await this.deps.repo.list(userId);
        return {
            activeProvider: active,
            canWriteCode: codeFunctionsEnabled() && isOwner(email),
            providers: [...this.deps.backends.values()].map((b) => ({ id: b.provider, label: b.label, models: b.models() })),
            agents: agents.map((a) => ({ ...this.dto(a), active: a.provider === active && this.deps.backends.has(a.provider) })),
        };
    }

    async setActiveProvider(userId: string, provider: unknown) {
        if (provider !== "anthropic" && provider !== "openai") throw new AgentError("Unknown provider");
        this.backend(provider);
        await this.deps.repo.setActiveProvider(userId, provider);
        return this.overview(userId);
    }

    async get(userId: string, id: string): Promise<NativeAgentRow> {
        const agent = await this.deps.repo.get(id, userId);
        if (!agent) throw new AgentError("Agent not found", 404);
        return agent;
    }

    async create(userId: string, body: any) {
        const input = await this.validate(body);
        const backend = this.backend(input.provider);
        if (input.provider !== (await this.activeProvider(userId))) {
            throw new AgentError(`Switch to ${backend.label} to create ${backend.label} agents`);
        }
        const remote = await backend.createAgent(spec(input), await this.toolsFor(userId, input, [], []));
        try {
            return this.dto(await this.deps.repo.create(userId, input, remote.remoteId, remote.version));
        } catch (err) {
            await backend.removeAgent(remote.remoteId).catch(() => {});
            throw err;
        }
    }

    async update(userId: string, id: string, body: any) {
        const existing = await this.get(userId, id);
        const input = await this.validate({ ...body, provider: existing.provider }); // provider can't change
        const backend = this.backend(existing.provider);
        if (!existing.remote_agent_id) throw new AgentError("This agent has no provider copy; delete it and create it again");
        const [http, code] = await Promise.all([this.deps.repo.listFunctions(id), this.deps.repo.listCodeFunctions(id)]);
        if (input.knowledge_base && [...http, ...code].some((f) => f.name === KB_TOOL)) throw new AgentError(`A function is already named "${KB_TOOL}"`);
        const { version } = await backend.updateAgent(existing.remote_agent_id, spec(input), await this.toolsFor(userId, input, http, code));
        const updated = await this.deps.repo.update(id, userId, input, version ?? existing.remote_version);
        if (!updated) throw new AgentError("Agent not found", 404);
        return this.dto(updated);
    }

    async delete(userId: string, id: string) {
        const agent = await this.get(userId, id);
        const backend = this.deps.backends.get(agent.provider);
        if (backend) {
            // Best effort: the local agent goes even if the provider copy is
            // already gone or the provider is unreachable.
            for (const rs of await this.deps.repo.remoteSessions(agent.id)) {
                await backend.removeSession(rs).catch((e) => console.warn(`[native-agents] couldn't remove session ${rs}:`, e?.message ?? e));
            }
            if (agent.remote_agent_id) {
                await backend.removeAgent(agent.remote_agent_id).catch((e) => console.warn(`[native-agents] couldn't remove agent ${agent.remote_agent_id}:`, e?.message ?? e));
            }
        }
        await this.deps.repo.delete(id, userId);
    }

    // ── chatting ──

    // The native agent a chat belongs to (or will belong to: the first message
    // of a new chat started from the agent's card). Throws when the agent is
    // disabled because the other provider is switched on.
    async agentForSession(sessionId: string, userId: string, requestedId?: string): Promise<{ agent: NativeAgentRow; remoteSessionId: string | null } | null> {
        const link = await this.deps.repo.sessionLink(sessionId, userId);
        if (!link) return null;
        let agentId = link.native_agent_id;
        if (!agentId && requestedId && !link.agent_id && !link.has_messages) {
            await this.get(userId, requestedId); // ownership check
            await this.deps.repo.attachSession(sessionId, userId, requestedId);
            agentId = requestedId;
        }
        if (!agentId) return null;
        const agent = await this.get(userId, agentId);
        const active = await this.activeProvider(userId);
        if (agent.provider !== active) {
            const label = this.deps.backends.get(agent.provider)?.label ?? agent.provider;
            throw new AgentError(`"${agent.name}" is a ${label} agent. Switch to ${label} on the Provider agents page to use it.`, 409);
        }
        return { agent, remoteSessionId: link.remote_session_id };
    }

    // Throws (409) when the agent's provider isn't the one switched on.
    async requireActive(userId: string, agent: NativeAgentRow): Promise<void> {
        if (agent.provider !== (await this.activeProvider(userId))) {
            const label = this.deps.backends.get(agent.provider)?.label ?? agent.provider;
            throw new AgentError(`"${agent.name}" is a ${label} agent. Switch to ${label} on the Provider agents page to use it.`, 409);
        }
    }

    // One prompt in its own chat (a pipeline step). The chat is linked to the
    // agent so its provider session is cleaned up when the agent is deleted.
    async runOnce(agent: NativeAgentRow, userId: string, sessionId: string, prompt: string, signal: AbortSignal): Promise<{ text: string; error: string | null }> {
        await this.requireActive(userId, agent);
        await this.deps.repo.attachSession(sessionId, userId, agent.id);
        let text = "";
        let error: string | null = null;
        const message = { type: "message", role: "user", content: [{ type: "text", text: prompt }] } as LLMMessage;
        // Nobody is watching a pipeline step, so browser approvals are cancelled.
        for await (const chunk of this.llmFor(agent, null, false).chatStream([message], userId, sessionId, "", signal)) {
            if (chunk.type === "message" && chunk.role === "assistant" && Array.isArray(chunk.content)) {
                for (const part of chunk.content as any[]) if (part?.type === "text") text += part.text ?? "";
            } else if (chunk.type === "error") {
                error = (chunk as any).message ?? "Something went wrong";
            } else if (chunk.type === "cancelled") {
                error = "The step took too long and was stopped.";
            }
        }
        return { text: text.trim(), error };
    }

    // An ILLM for one chat turn, so the chat route, usage tracking and history
    // work exactly as they do for normal chats.
    llmFor(agent: NativeAgentRow, remoteSessionId: string | null, interactive = true): ILLM {
        return new UsageTrackingLLM(new NativeAgentLLM(this, agent, remoteSessionId, interactive), this.deps.usage);
    }

    get messages() { return this.deps.messageService; }
    backendFor(provider: NativeProvider) { return this.backend(provider); }
    setRemoteSession(sessionId: string, remoteId: string) { return this.deps.repo.setRemoteSession(sessionId, remoteId); }

    // Tools our server answers for the agent: the knowledge base search plus
    // the agent's enabled HTTP and code functions. The provider only gets
    // their names, descriptions and parameters; they run here.
    async toolsFor(userId: string, a: Pick<NativeAgentInput, "knowledge_base">, http: AgentFunctionRow[], code: AgentCodeFunctionRow[]): Promise<NativeTool[]> {
        const defs: ToolDefinition[] = [];
        if (a.knowledge_base) defs.push(createVectorSearchTool(this.deps.vectorDb, this.deps.embed));
        for (const fn of http) if (fn.enabled) defs.push(httpFunctionTool(fn));
        if (codeFunctionsEnabled()) for (const fn of code) if (fn.enabled) defs.push(codeFunctionTool(fn));
        return defs.map((d) => ({
            name: d.name,
            description: d.description,
            parameters: d.parameters as unknown as Record<string, unknown>,
            run: async (args) => {
                const db = await this.deps.messageService.rawDb();
                const out = await d.execute(args, { db: db as any, userId });
                const text = typeof out === "string" ? out : JSON.stringify(out);
                return text.length > MAX_TOOL_OUTPUT_CHARS ? text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n…[truncated]" : text;
            },
        }));
    }

    // Tools for a saved agent, as stored.
    async agentTools(userId: string, agent: NativeAgentRow): Promise<NativeTool[]> {
        const [http, code] = await Promise.all([this.deps.repo.listFunctions(agent.id), this.deps.repo.listCodeFunctions(agent.id)]);
        return this.toolsFor(userId, agent, http, code);
    }

    // ── functions ──
    // Every change is pushed to the provider first (the agent's tool list
    // lives there too) and saved here only once the provider accepted it.

    async listFunctions(userId: string, email: string | undefined, agentId: string) {
        await this.get(userId, agentId);
        const [http, code] = await Promise.all([this.deps.repo.listFunctions(agentId), this.deps.repo.listCodeFunctions(agentId)]);
        return { functions: http.map(functionDto), codeFunctions: code.map(codeFunctionDto), canWriteCode: codeFunctionsEnabled() && isOwner(email) };
    }

    private async pushTools(userId: string, agent: NativeAgentRow, http: AgentFunctionRow[], code: AgentCodeFunctionRow[]) {
        if (!agent.remote_agent_id) throw new AgentError("This agent has no provider copy; delete it and create it again");
        const backend = this.backend(agent.provider);
        const { version } = await backend.updateAgent(agent.remote_agent_id, spec(agent), await this.toolsFor(userId, agent, http, code));
        await this.deps.repo.setRemoteVersion(agent.id, version);
    }

    private assertNameFree(agent: NativeAgentRow, name: string, http: AgentFunctionRow[], code: AgentCodeFunctionRow[], ignoreId?: string) {
        if (name === KB_TOOL) throw new AgentError(`"${KB_TOOL}" is reserved for the documents search`);
        if ([...http, ...code].some((f) => f.name === name && f.id !== ignoreId)) throw new AgentError(`This agent already has a function named "${name}"`);
    }

    private async functionsOf(agentId: string) {
        return Promise.all([this.deps.repo.listFunctions(agentId), this.deps.repo.listCodeFunctions(agentId)]);
    }

    async createFunction(userId: string, agentId: string, body: any) {
        const agent = await this.get(userId, agentId);
        const input = this.deps.agents.normalizeFunction(body, null);
        await this.publicUrl(input.url);
        const [http, code] = await this.functionsOf(agentId);
        this.assertNameFree(agent, input.name, http, code);
        const pending = { ...input, id: "pending", agent_id: agentId, created_at: new Date() } as AgentFunctionRow;
        await this.pushTools(userId, agent, [...http, pending], code);
        return functionDto(await this.deps.repo.createFunction(agentId, input));
    }

    async updateFunction(userId: string, agentId: string, fnId: string, body: any) {
        const agent = await this.get(userId, agentId);
        const existing = await this.deps.repo.getFunction(agentId, fnId);
        if (!existing) throw new AgentError("Function not found", 404);
        const input = this.deps.agents.normalizeFunction(body, existing);
        await this.publicUrl(input.url);
        const [http, code] = await this.functionsOf(agentId);
        this.assertNameFree(agent, input.name, http, code, fnId);
        await this.pushTools(userId, agent, http.map((f) => (f.id === fnId ? { ...f, ...input } : f)), code);
        return functionDto((await this.deps.repo.updateFunction(agentId, fnId, input))!);
    }

    async deleteFunction(userId: string, agentId: string, fnId: string) {
        const agent = await this.get(userId, agentId);
        const [http, code] = await this.functionsOf(agentId);
        if (!http.some((f) => f.id === fnId)) throw new AgentError("Function not found", 404);
        await this.pushTools(userId, agent, http.filter((f) => f.id !== fnId), code);
        await this.deps.repo.deleteFunction(agentId, fnId);
    }

    async testFunction(userId: string, agentId: string, body: any) {
        await this.get(userId, agentId);
        const existing = typeof body?.functionId === "string" ? await this.deps.repo.getFunction(agentId, body.functionId) : null;
        const fn = this.deps.agents.normalizeFunction(body?.function ?? {}, existing);
        await this.publicUrl(fn.url);
        try {
            return await callHttpFunction(fn, typeof body?.args === "object" && body.args ? body.args : {});
        } catch (err) {
            throw new AgentError(err instanceof Error ? err.message : "Request failed");
        }
    }

    private async publicUrl(url: string) {
        await assertPublicUrl(url.replace(/\{[^}]+\}/g, "x")).catch((e) => { throw new AgentError(e.message); });
    }

    // ── code functions (owner only, same rule as regular agents) ──
    private requireOwner(email?: string) {
        if (!codeFunctionsEnabled()) throw new AgentError("Code functions are turned off. Add your email to OWNER_EMAILS in the backend .env and restart.", 403);
        if (!isOwner(email)) throw new AgentError("Only the app owner can write or run code functions.", 403);
    }

    async createCodeFunction(userId: string, email: string | undefined, agentId: string, body: any) {
        this.requireOwner(email);
        const agent = await this.get(userId, agentId);
        const input = this.deps.agents.normalizeCodeFunction(body, null);
        const [http, code] = await this.functionsOf(agentId);
        this.assertNameFree(agent, input.name, http, code);
        const pending = { ...input, id: "pending", agent_id: agentId, created_at: new Date(), updated_at: new Date() } as AgentCodeFunctionRow;
        await this.pushTools(userId, agent, http, [...code, pending]);
        return codeFunctionDto(await this.deps.repo.createCodeFunction(agentId, input));
    }

    async updateCodeFunction(userId: string, email: string | undefined, agentId: string, fnId: string, body: any) {
        this.requireOwner(email);
        const agent = await this.get(userId, agentId);
        const existing = await this.deps.repo.getCodeFunction(agentId, fnId);
        if (!existing) throw new AgentError("Code function not found", 404);
        const input = this.deps.agents.normalizeCodeFunction({ ...existing, ...body }, existing);
        const [http, code] = await this.functionsOf(agentId);
        this.assertNameFree(agent, input.name, http, code, fnId);
        await this.pushTools(userId, agent, http, code.map((f) => (f.id === fnId ? { ...f, ...input } : f)));
        return codeFunctionDto((await this.deps.repo.updateCodeFunction(agentId, fnId, input))!);
    }

    // Deleting is allowed for the agent's owner even if code functions are off.
    async deleteCodeFunction(userId: string, agentId: string, fnId: string) {
        const agent = await this.get(userId, agentId);
        const [http, code] = await this.functionsOf(agentId);
        if (!code.some((f) => f.id === fnId)) throw new AgentError("Code function not found", 404);
        await this.pushTools(userId, agent, http, code.filter((f) => f.id !== fnId));
        await this.deps.repo.deleteCodeFunction(agentId, fnId);
    }

    async testCodeFunction(userId: string, email: string | undefined, agentId: string, body: any) {
        this.requireOwner(email);
        await this.get(userId, agentId);
        const existing = typeof body?.functionId === "string" ? await this.deps.repo.getCodeFunction(agentId, body.functionId) : null;
        const fn = this.deps.agents.normalizeCodeFunction(body?.function ?? {}, existing);
        try {
            return await runPython(fn.code, typeof body?.args === "object" && body.args ? body.args : {}, decryptCodeSecrets(fn), fn.timeout_ms);
        } catch (err) {
            throw new AgentError(err instanceof Error ? err.message : "Couldn't run the function", 503);
        }
    }

    private async validate(b: any): Promise<NativeAgentInput> {
        const provider = b?.provider;
        if (provider !== "anthropic" && provider !== "openai") throw new AgentError("Choose Claude or ChatGPT");
        const backend = this.backend(provider);
        const name = str(b?.name, 120, "Name", true);
        const model = str(b?.model, 100, "Model") || backend.models()[0];
        if (!backend.models().includes(model)) throw new AgentError(`Model "${model}" isn't available for ${backend.label} agents`);

        const rawServers: any[] = Array.isArray(b?.mcp_servers) ? b.mcp_servers : [];
        if (rawServers.length > MAX_MCP_SERVERS) throw new AgentError(`At most ${MAX_MCP_SERVERS} MCP servers`);
        const mcp_servers: NativeMcpServer[] = [];
        for (const s of rawServers) {
            const sname = str(s?.name, 64, "MCP server name", true);
            if (!MCP_NAME_RE.test(sname)) throw new AgentError(`MCP server name "${sname}" may only use letters, numbers, - and _`);
            if (mcp_servers.some((m) => m.name === sname)) throw new AgentError("MCP server names must be unique");
            const url = str(s?.url, 500, "MCP server URL", true);
            let parsed: URL;
            try {
                parsed = await assertPublicUrl(url);
            } catch (err) {
                throw new AgentError(err instanceof Error ? err.message : "Invalid MCP server URL");
            }
            if (parsed.protocol !== "https:") throw new AgentError("MCP server URLs must use https");
            mcp_servers.push({ name: sname, url: parsed.toString() });
        }

        return {
            provider,
            name,
            icon: str(b?.icon, 8, "Icon") || "🤖",
            description: str(b?.description, 500, "Description"),
            instructions: str(b?.instructions, 50_000, "Instructions"),
            model,
            web_search: !!b?.web_search,
            code_sandbox: !!b?.code_sandbox,
            knowledge_base: !!b?.knowledge_base,
            browser: this.browserFlag(provider, b?.browser),
            mcp_servers,
        };
    }

    private browserFlag(provider: NativeProvider, value: unknown): boolean {
        if (!value) return false;
        if (provider !== "openai") throw new AgentError("The browser is only available for ChatGPT agents (OpenAI computer use)");
        return true;
    }

    private dto(a: NativeAgentRow) {
        const { user_id: _u, ...rest } = a;
        return rest;
    }
}

const spec = (a: NativeAgentInput | NativeAgentRow): NativeAgentSpec => ({
    name: a.name, description: a.description, instructions: a.instructions, model: a.model,
    web_search: a.web_search, code_sandbox: a.code_sandbox, knowledge_base: a.knowledge_base, browser: !!a.browser, mcp_servers: a.mcp_servers,
});

// Adapts one native agent to the ILLM interface the chat route uses. It saves
// the user's message and the reply in our chat history (so search, usage,
// reload and the sidebar work), and keeps the provider's session id so the
// conversation continues in the same remote session next turn.
class NativeAgentLLM implements ILLM {
    constructor(private svc: NativeAgentService, private agent: NativeAgentRow, private remoteSessionId: string | null, private interactive = true) {}

    getProvider() { return this.agent.provider; }
    getModel() { return this.agent.model; }
    getModels() { return [this.agent.model]; }
    supportsTools() { return true; }
    chat(): never { throw new Error("Native agents only support streaming chat"); }
    async summarizeChat(): Promise<string> { return ""; }

    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string, _apiKey: string, signal: AbortSignal, _model?: string, _run?: ChatRunOptions): AsyncGenerator<LLMMessage, void, unknown> {
        const ms = this.svc.messages;
        const text = messageText(messages);
        if (!text) {
            yield { type: "error", message: "Provider agents can only read text messages for now." } as LLMMessage;
            return;
        }
        await ms.runTransaction(sessionId, messages);

        // First message of the chat names it.
        const session = await ms.getSession(sessionId, userId);
        if (!session?.title || session.title === "New Chat") {
            const title = text.replace(/\s+/g, " ").slice(0, 60) + (text.length > 60 ? "…" : "");
            await ms.updateTitle(sessionId, userId, title);
            yield { type: "session_title", content: title } as LLMMessage;
        }

        const backend = this.svc.backendFor(this.agent.provider);
        let reply = "";
        let failed: string | null = null;
        const toolRows: LLMMessage[] = [];
        try {
            for await (const ev of backend.runTurn({
                remoteAgentId: this.agent.remote_agent_id!,
                remoteSessionId: this.remoteSessionId,
                spec: spec(this.agent),
                title: session?.title ?? text.slice(0, 60),
                text,
                tools: await this.svc.agentTools(userId, this.agent),
                signal,
                onSession: async (rid) => { this.remoteSessionId = rid; await this.svc.setRemoteSession(sessionId, rid); },
                approve: this.interactive ? (req) => this.svc.waitForApproval(userId, req, signal) : undefined,
            })) {
                switch (ev.type) {
                    case "text":
                        reply += ev.text;
                        yield { type: "message", role: "assistant", content: [{ type: "text", text: ev.text }] } as LLMMessage;
                        break;
                    case "tool_start": {
                        const args = ev.input === undefined ? "" : typeof ev.input === "string" ? ev.input : JSON.stringify(ev.input);
                        yield { type: "function_call", tool_call_id: ev.id, name: ev.name } as LLMMessage;
                        if (args) yield { type: "function_call_args", tool_call_id: ev.id, args } as unknown as LLMMessage;
                        toolRows.push({ role: "tool_call", type: "tool_call", tool_call_id: ev.id, name: ev.name, arguments: safeArgs(ev.input) } as LLMMessage);
                        break;
                    }
                    case "tool_end":
                        yield { type: "function_call_output", tool_call_id: ev.id, output: ev.output ?? "" } as LLMMessage;
                        if (!toolRows.some((r) => r.role === "tool_call" && r.tool_call_id === ev.id)) {
                            toolRows.push({ role: "tool_call", type: "tool_call", tool_call_id: ev.id, name: ev.name, arguments: {} } as LLMMessage);
                        }
                        toolRows.push({ role: "tool_call_output", type: "tool_call_output", tool_call_id: ev.id, output: ev.output ?? "" } as LLMMessage);
                        break;
                    case "usage":
                        yield usageIncrement(ev.usage, ev.model);
                        break;
                    case "approval_request": {
                        // Shown in the chat for the user to answer. Never includes typed values.
                        const r = ev.request;
                        yield { type: "approval_request", request: r } as unknown as LLMMessage;
                        toolRows.push({ role: "tool_call", type: "tool_call", tool_call_id: r.requestId, name: r.kind === "origin" ? "browser_permission" : "browser_sign_in",
                            arguments: { origin: r.origin, reason: r.reason } } as LLMMessage);
                        break;
                    }
                    case "approval_resolved":
                        yield { type: "approval_resolved", request_id: ev.requestId, outcome: ev.outcome } as unknown as LLMMessage;
                        toolRows.push({ role: "tool_call_output", type: "tool_call_output", tool_call_id: ev.requestId, output: ev.outcome } as LLMMessage);
                        break;
                    case "screenshot":
                        // Live only: screenshots are large, so they aren't saved in the history.
                        yield { type: "browser_screenshot", tool_call_id: ev.id, image: ev.image } as unknown as LLMMessage;
                        break;
                    case "error":
                        failed = ev.message;
                        break;
                }
            }
        } catch (err) {
            if (!signal.aborted) failed = err instanceof Error ? err.message : String(err);
        }

        // History: tool calls (paired with outputs) first, then the reply.
        const paired = toolRows.filter((r) => r.role !== "tool_call" || toolRows.some((o) => o.role === "tool_call_output" && o.tool_call_id === r.tool_call_id));
        const ordered = [...paired.filter((r) => r.role === "tool_call"), ...paired.filter((r) => r.role === "tool_call_output")];
        if (ordered.length) await ms.runTransaction(sessionId, ordered).catch((e) => console.error("[native-agents] couldn't save tool calls:", e));
        if (reply) {
            await ms.createLLMMessage(sessionId, {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: reply }],
                metadata: { provider: this.agent.provider, model: this.agent.model, native_agent: true, ...(signal.aborted ? { cancelled: true } : {}) },
            } as LLMMessage);
        }

        if (signal.aborted) {
            yield { type: "cancelled", content: [{ type: "aborted", text: "Request cancelled." }] } as unknown as LLMMessage;
            return;
        }
        if (failed && !reply) {
            yield { type: "error", message: failed } as LLMMessage;
            return;
        }
        yield { content: "", isDone: true } as unknown as LLMMessage;
    }
}

function messageText(messages: LLMMessage[]): string {
    const parts: string[] = [];
    for (const m of messages) {
        if (typeof m.content === "string") parts.push(m.content);
        else if (Array.isArray(m.content)) for (const c of m.content as any[]) if ((c?.type === "text" || c?.type === "input_text") && c.text) parts.push(c.text);
    }
    return parts.join("\n\n").trim();
}

function safeArgs(input: unknown): Record<string, unknown> {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
    if (typeof input === "string") {
        try { const v = JSON.parse(input); if (v && typeof v === "object") return v; } catch { /* not JSON */ }
        return { input };
    }
    return {};
}
