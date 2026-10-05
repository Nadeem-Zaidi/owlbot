// The Agents API needs openai v7; the rest of the app stays on v6 for now.
import OpenAI from "openai-agents-v7";
import { ApprovalAnswer, ApprovalRequest, NativeAgentSpec, NativeBackend, NativeTool, NativeTurnEvent, NativeTurnOptions, cancelAnswer, envList, short } from "./native_types";

// OpenAI Agents API (beta): OpenAI stores the agent, runs the harness, and
// (optionally) hosts a sandbox container per session.
export class OpenAINativeBackend implements NativeBackend {
    readonly provider = "openai" as const;
    readonly label = "ChatGPT";
    private client: OpenAI;

    constructor(apiKey: string) {
        this.client = new OpenAI({ apiKey });
    }

    models(): string[] {
        return envList("OPENAI_NATIVE_AGENT_MODELS", ["gpt-6-astra"]);
    }

    private agentBody(spec: NativeAgentSpec, tools: NativeTool[]) {
        const list: any[] = [];
        if (spec.web_search) list.push({ type: "web_search" });
        // A browser on OpenAI's side; screenshots come back so the chat can show them.
        if (spec.browser) list.push({ type: "computer_use", include_screenshots: true });
        for (const s of spec.mcp_servers) list.push({ type: "mcp", server_label: s.name, transport: { type: "http", server_url: s.url } });
        for (const t of tools) list.push({ type: "function", name: t.name, description: t.description, parameters: t.parameters });
        return {
            name: spec.name,
            model: spec.model,
            instructions: spec.instructions || null,
            metadata: { app: "owlbot", ...(spec.description ? { description: spec.description.slice(0, 500) } : {}) },
            tools: list,
        };
    }

    async createAgent(spec: NativeAgentSpec, tools: NativeTool[]) {
        const agent = await this.client.beta.agents.create(this.agentBody(spec, tools));
        return { remoteId: agent.id, version: null };
    }

    async updateAgent(remoteId: string, spec: NativeAgentSpec, tools: NativeTool[]) {
        await this.client.beta.agents.update(remoteId, this.agentBody(spec, tools));
        return { version: null };
    }

    async removeAgent(remoteId: string) {
        await this.client.beta.agents.delete(remoteId);
    }

    async removeSession(remoteSessionId: string) {
        await this.client.beta.agents.sessions.delete(remoteSessionId);
    }

    async *runTurn(o: NativeTurnOptions): AsyncGenerator<NativeTurnEvent> {
        const sessions = this.client.beta.agents.sessions;
        const input = [{ role: "user" as const, content: [{ type: "input_text" as const, text: o.text }] }];
        let sid = o.remoteSessionId;
        let stream: AsyncIterable<any> & { controller: AbortController };

        if (!sid) {
            // A new session starts its first turn in the same call.
            stream = await sessions.create({
                agent_id: o.remoteAgentId,
                environment: environmentFor(o.spec),
                input,
                metadata: { app: "owlbot" },
                stream: true,
            }) as any;
        } else {
            stream = await sessions.events.stream(sid) as any;
            await sessions.events.create(sid, { events: [{ type: "agent.session.input.message", input }] });
        }

        const toolsByName = new Map(o.tools.map((t) => [t.name, t]));
        const answered = new Set<string>();
        let turnDone = false;
        const onAbort = () => {
            if (sid) void sessions.events.create(sid, { events: [{ type: "agent.session.input.cancel" }] }).catch(() => {});
            stream.controller.abort();
        };
        o.signal.addEventListener("abort", onAbort, { once: true });

        try {
            for await (const ev of stream) {
                switch (ev.type) {
                    case "agent.session.created":
                        sid = ev.session.id as string;
                        await o.onSession(sid);
                        break;
                    case "agent.session.turn.output_text.delta":
                        if (ev.delta) yield { type: "text", text: ev.delta };
                        break;
                    case "agent.session.turn.item.added": {
                        const t = toolItem(ev.item);
                        if (t) yield { type: "tool_start", id: ev.item.id, name: t.name, input: t.input };
                        break;
                    }
                    case "agent.session.turn.item.done": {
                        const t = toolItem(ev.item);
                        if (t && ev.item.type !== "function_call") {
                            yield { type: "tool_end", id: ev.item.id, name: t.name, output: t.output, isError: ev.item.status === "failed" };
                        }
                        const shot = ev.item?.type === "computer_use_call" ? ev.item.output?.image_url : null;
                        if (typeof shot === "string" && shot.startsWith("data:image/")) yield { type: "screenshot", id: ev.item.id, image: shot };
                        break;
                    }
                    case "agent.session.requires_action": {
                        // Our own functions (knowledge base): run them and answer.
                        for (const action of ev.session?.required_actions ?? []) {
                            // The hosted browser wants permission for a site, or a sign-in.
                            if (action.type === "computer_use_approval_request") {
                                if (answered.has(action.request_id)) continue;
                                answered.add(action.request_id);
                                const req = approvalRequest(action);
                                if (!req) continue;
                                yield { type: "approval_request", request: req };
                                const answer = o.approve ? await o.approve(req) : cancelAnswer(req);
                                await sessions.events.create(sid!, {
                                    events: [{ type: "agent.session.input.computer_use_approval_request_result", request_id: action.request_id, response: approvalResponse(answer) as any }],
                                });
                                yield { type: "approval_resolved", requestId: req.requestId, outcome: outcomeLabel(answer) };
                                continue;
                            }
                            if (action.type !== "function_call" || answered.has(action.call_id)) continue;
                            answered.add(action.call_id);
                            const tool = toolsByName.get(action.name);
                            let output: string;
                            let success = true;
                            try {
                                if (!tool) throw new Error(`Unknown tool "${action.name}"`);
                                const args = typeof action.arguments === "string" ? JSON.parse(action.arguments || "{}") : (action.arguments ?? {});
                                output = await tool.run(args);
                            } catch (err) {
                                output = err instanceof Error ? err.message : String(err);
                                success = false;
                            }
                            await sessions.events.create(sid!, {
                                events: [{
                                    type: "agent.session.input.tool_result",
                                    call_id: action.call_id,
                                    turn_id: action.turn_id,
                                    success,
                                    ...(success ? { output } : { error: output }),
                                }],
                            });
                            yield { type: "tool_end", id: action.call_id, name: action.name, output: short(output), isError: !success };
                        }
                        break;
                    }
                    case "agent.session.turn.completed":
                    case "agent.session.turn.failed":
                    case "agent.session.turn.cancelled": {
                        if (ev.turn?.subagent_id) break; // only the root agent's turn ends ours
                        turnDone = true;
                        const u = ev.usage;
                        if (u) {
                            const cached = u.input_tokens_details?.cached_tokens ?? 0;
                            yield {
                                type: "usage",
                                model: o.spec.model,
                                usage: { input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached), output_tokens: u.output_tokens ?? 0, cache_read_tokens: cached },
                            };
                        }
                        if (ev.type === "agent.session.turn.failed") yield { type: "error", message: ev.turn?.error?.message ?? "The agent's turn failed." };
                        break;
                    }
                    case "error":
                        yield { type: "error", message: ev.error?.message ?? "OpenAI reported an error" };
                        break;
                    case "agent.session.failed":
                        yield { type: "error", message: ev.session?.error ?? "The agent session failed." };
                        return;
                    case "agent.session.idle":
                        if (turnDone) return; // the session starts idle; only stop after our turn
                        break;
                }
            }
        } finally {
            o.signal.removeEventListener("abort", onAbort);
            stream.controller.abort();
        }
    }
}

// Tool-ish items worth showing as a card in the chat.
function toolItem(item: any): { name: string; input?: unknown; output?: string } | null {
    switch (item?.type) {
        case "function_call": return { name: item.name, input: item.arguments };
        case "mcp_call": return { name: `${item.server_label}: ${item.name}`, input: item.arguments, output: short(item.output ?? item.error ?? "") };
        case "web_search_call": return { name: "web_search", input: item.action ?? undefined, output: item.status };
        case "command_execution": return { name: "shell", input: { command: item.command }, output: short(item.output ?? "") };
        case "computer_use_call": return { name: "browser", input: item.title ? { step: item.title } : undefined, output: item.title ?? item.status };
        default: return null;
    }
}

// The browser needs a hosted desktop; the sandbox alone needs a hosted container.
function environmentFor(spec: NativeAgentSpec): any {
    if (spec.browser) return { type: "openai_hosted", desktop: { enabled: true } };
    if (spec.code_sandbox) return { type: "openai_hosted" };
    return { type: "none" };
}

function approvalRequest(action: any): ApprovalRequest | null {
    const r = action.request ?? {};
    if (r.type === "browser_origin_access") {
        return { kind: "origin", requestId: action.request_id, origin: String(r.origin ?? ""), reason: r.reason ?? null };
    }
    if (r.type === "browser_authentication") {
        return {
            kind: "signin",
            requestId: action.request_id,
            origin: r.credential_origin ?? null,
            reason: r.reason ?? null,
            fields: (r.fields ?? []).map((f: any) => ({ id: String(f.id), label: String(f.label ?? f.id), required: !!f.required, type: String(f.type ?? "text") })),
            options: (r.options ?? []).map((o: any) => ({ id: String(o.id), label: String(o.label ?? o.id), field_ids: (o.field_ids ?? []).map(String) })),
        };
    }
    return null;
}

function approvalResponse(a: ApprovalAnswer) {
    if (a.kind === "origin") return { type: "browser_origin_access", decision: a.decision };
    if (a.action === "cancel") return { type: "browser_authentication", action: "cancel" };
    return { type: "browser_authentication", action: "submit", fields: a.fields, ...(a.selected_option ? { selected_option: a.selected_option } : {}) };
}

function outcomeLabel(a: ApprovalAnswer): string {
    if (a.kind === "origin") return a.decision === "approve" ? "allowed" : a.decision === "deny" ? "denied" : "cancelled";
    return a.action === "submit" ? "signed in" : "sign-in cancelled";
}

