import Anthropic from "@anthropic-ai/sdk";
import { NativeAgentRepository } from "../../repository/native_agent_repository";
import { NativeAgentSpec, NativeBackend, NativeTool, NativeTurnEvent, NativeTurnOptions, envList, short } from "./native_types";

const ENV_STATE_KEY = "anthropic_environment_id";
const ENV_NAME = "owlbot-native-agents";
const SANDBOX_TOOLS = ["bash", "read", "write", "edit", "glob", "grep"] as const;
const WEB_TOOLS = ["web_search", "web_fetch"] as const;

// Claude Managed Agents: Anthropic stores the agent (versioned), runs the
// agent loop, and hosts a per-session container for bash/files/code.
export class ClaudeNativeBackend implements NativeBackend {
    readonly provider = "anthropic" as const;
    readonly label = "Claude";
    private client: Anthropic;
    private envId: Promise<string> | null = null;

    constructor(apiKey: string, private repo: NativeAgentRepository) {
        this.client = new Anthropic({ apiKey });
    }

    models(): string[] {
        return envList("ANTHROPIC_NATIVE_AGENT_MODELS", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]);
    }

    private agentBody(spec: NativeAgentSpec, tools: NativeTool[]) {
        const toolset: any[] = [];
        if (spec.code_sandbox || spec.web_search) {
            toolset.push({
                type: "agent_toolset_20260401",
                default_config: { enabled: false },
                configs: [
                    ...SANDBOX_TOOLS.map((name) => ({ name, enabled: spec.code_sandbox })),
                    ...WEB_TOOLS.map((name) => ({ name, enabled: spec.web_search })),
                ],
            });
        }
        for (const s of spec.mcp_servers) {
            // MCP tools default to always_ask; this app has no approval UI, so
            // they run like the MCP tools on regular agents do.
            toolset.push({ type: "mcp_toolset", mcp_server_name: s.name, default_config: { permission_policy: { type: "always_allow" } } });
        }
        for (const t of tools) {
            toolset.push({ type: "custom", name: t.name, description: t.description, input_schema: t.parameters });
        }
        return {
            name: spec.name,
            model: spec.model,
            system: spec.instructions || null,
            description: spec.description || null,
            tools: toolset,
            mcp_servers: spec.mcp_servers.map((s) => ({ type: "url" as const, name: s.name, url: s.url })),
            metadata: { app: "owlbot" },
        };
    }

    async createAgent(spec: NativeAgentSpec, tools: NativeTool[]) {
        const agent = await this.client.beta.agents.create(this.agentBody(spec, tools) as any);
        return { remoteId: agent.id, version: agent.version ?? null };
    }

    // Each update is a new immutable version; new chats use the latest.
    async updateAgent(remoteId: string, spec: NativeAgentSpec, tools: NativeTool[]) {
        const agent = await this.client.beta.agents.update(remoteId, this.agentBody(spec, tools) as any);
        return { version: agent.version ?? null };
    }

    async removeAgent(remoteId: string) {
        // Archive is the only terminal state Managed Agents has; it's what the
        // user asked for when they delete the agent here.
        await this.client.beta.agents.archive(remoteId);
    }

    async removeSession(remoteSessionId: string) {
        await this.client.beta.sessions.delete(remoteSessionId);
    }

    // One shared cloud environment for every native Claude agent on this server.
    private environment(): Promise<string> {
        this.envId ??= (async () => {
            const saved = await this.repo.getState(ENV_STATE_KEY);
            if (saved) return saved;
            let id: string | null = null;
            try {
                const env = await this.client.beta.environments.create({
                    name: ENV_NAME,
                    config: { type: "cloud", networking: { type: "limited", allow_package_managers: true, allow_mcp_servers: true } },
                } as any);
                id = env.id;
            } catch (err) {
                if (!(err instanceof Anthropic.ConflictError)) throw err;
                // Already created by an earlier run (names are unique): reuse it.
                for await (const env of this.client.beta.environments.list()) {
                    if ((env as any).name === ENV_NAME && !(env as any).archived_at) { id = env.id; break; }
                }
                if (!id) throw err;
            }
            await this.repo.setState(ENV_STATE_KEY, id);
            return id;
        })().catch((err) => { this.envId = null; throw err; });
        return this.envId;
    }

    async *runTurn(o: NativeTurnOptions): AsyncGenerator<NativeTurnEvent> {
        let sessionId = o.remoteSessionId;
        if (!sessionId) {
            const session = await this.client.beta.sessions.create({
                agent: o.remoteAgentId, // latest version
                environment_id: await this.environment(),
                title: o.title.slice(0, 200),
            });
            sessionId = session.id;
            await o.onSession(sessionId);
        }
        const sid = sessionId;
        const toolsByName = new Map(o.tools.map((t) => [t.name, t]));
        const toolNames = new Map<string, string>();
        const preview = new Map<string, string>(); // event id → text already streamed

        // Stream first, then send, so no early event is missed.
        const stream = await this.client.beta.sessions.events.stream(sid, { event_deltas: ["agent.message"] });
        const onAbort = () => {
            void this.client.beta.sessions.events.send(sid, { events: [{ type: "user.interrupt" }] }).catch(() => {});
            stream.controller.abort();
        };
        o.signal.addEventListener("abort", onAbort, { once: true });
        try {
            await this.client.beta.sessions.events.send(sid, {
                events: [{ type: "user.message", content: [{ type: "text", text: o.text }] }],
            });

            for await (const ev of stream as AsyncIterable<any>) {
                switch (ev.type) {
                    case "event_delta": {
                        const text = ev.delta?.content?.type === "text" ? String(ev.delta.content.text ?? "") : "";
                        if (text) {
                            preview.set(ev.event_id, (preview.get(ev.event_id) ?? "") + text);
                            yield { type: "text", text };
                        }
                        break;
                    }
                    case "agent.message": {
                        // The buffered message is authoritative; send whatever the
                        // live preview missed (deltas are best-effort).
                        const full = (ev.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
                        const seen = preview.get(ev.id) ?? "";
                        if (full.startsWith(seen) && full.length > seen.length) yield { type: "text", text: full.slice(seen.length) };
                        else if (!seen && full) yield { type: "text", text: full };
                        preview.delete(ev.id);
                        break;
                    }
                    case "agent.tool_use":
                    case "agent.mcp_tool_use":
                        toolNames.set(ev.id, ev.name);
                        yield { type: "tool_start", id: ev.id, name: ev.type === "agent.mcp_tool_use" ? `${ev.mcp_server_name ?? "mcp"}: ${ev.name}` : ev.name, input: ev.input };
                        break;
                    case "agent.tool_result":
                    case "agent.mcp_tool_result": {
                        const useId = ev.tool_use_id ?? ev.mcp_tool_use_id;
                        yield { type: "tool_end", id: useId, name: toolNames.get(useId) ?? "tool", output: short(contentText(ev.content)), isError: !!ev.is_error };
                        break;
                    }
                    case "agent.custom_tool_use": {
                        yield { type: "tool_start", id: ev.id, name: ev.name, input: ev.input };
                        const tool = toolsByName.get(ev.name);
                        let output: string;
                        let isError = false;
                        try {
                            if (!tool) throw new Error(`Unknown tool "${ev.name}"`);
                            output = await tool.run(ev.input ?? {});
                        } catch (err) {
                            output = err instanceof Error ? err.message : String(err);
                            isError = true;
                        }
                        await this.client.beta.sessions.events.send(sid, {
                            events: [{ type: "user.custom_tool_result", custom_tool_use_id: ev.id, content: [{ type: "text", text: output }], ...(isError ? { is_error: true } : {}) } as any],
                        });
                        yield { type: "tool_end", id: ev.id, name: ev.name, output: short(output), isError };
                        break;
                    }
                    case "span.model_request_end": {
                        const u = ev.model_usage ?? {};
                        yield {
                            type: "usage",
                            model: o.spec.model,
                            usage: {
                                input_tokens: u.input_tokens ?? 0,
                                output_tokens: u.output_tokens ?? 0,
                                cache_read_tokens: u.cache_read_input_tokens ?? 0,
                                cache_write_tokens: u.cache_creation_input_tokens ?? 0,
                            },
                        };
                        break;
                    }
                    case "session.error":
                        if (ev.error?.retry_status?.type === "retrying") break; // Claude retries this itself
                        yield { type: "error", message: ev.error?.message ?? "Claude reported an error" };
                        break;
                    case "session.status_idle": {
                        const reason = ev.stop_reason?.type;
                        if (reason === "requires_action") break; // waiting on a tool result we're sending
                        if (reason === "retries_exhausted") yield { type: "error", message: "Claude couldn't finish this turn (retries exhausted)." };
                        if (reason === "budget_reached") yield { type: "error", message: "This session reached its spending limit." };
                        return;
                    }
                    case "session.status_terminated":
                        return;
                }
            }
        } finally {
            o.signal.removeEventListener("abort", onAbort);
            stream.controller.abort();
        }
    }
}

function contentText(content: unknown): string {
    if (!Array.isArray(content)) return typeof content === "string" ? content : "";
    return content.map((b: any) => (b?.type === "text" ? b.text : "")).join("");
}
