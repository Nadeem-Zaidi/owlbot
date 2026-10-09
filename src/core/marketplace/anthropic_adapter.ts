import Anthropic from "@anthropic-ai/sdk";
import type { Route } from "./router";

// Claude for the developer API: customers send OpenAI chat-completions
// requests; this translates them to Claude's native Messages API (through
// the official SDK) and translates the reply — JSON or a stream — back to the
// OpenAI format. Returned as a fetch-style Response, so the API code treats
// Claude like any other provider.

type Json = Record<string, any>;

const FINISH: Record<string, string> = {
    end_turn: "stop",
    stop_sequence: "stop",
    max_tokens: "length",
    tool_use: "tool_calls",
    pause_turn: "stop",
    refusal: "content_filter",
};

export class AnthropicRequestError extends Error {}

const textOf = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : "")).join("");
    return "";
};

function imageBlock(url: string): Json | null {
    const data = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i);
    if (data) return { type: "image", source: { type: "base64", media_type: data[1].toLowerCase(), data: data[2] } };
    if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
    return null;
}

function userBlocks(content: unknown): Json[] {
    if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
    if (!Array.isArray(content)) return [];
    const out: Json[] = [];
    for (const p of content as any[]) {
        if (p?.type === "text" && typeof p.text === "string" && p.text) out.push({ type: "text", text: p.text });
        else if (p?.type === "image_url") {
            const img = imageBlock(String(p.image_url?.url ?? p.image_url ?? ""));
            if (img) out.push(img);
        }
    }
    return out;
}

const parseArgs = (raw: unknown): Json => {
    if (raw && typeof raw === "object") return raw as Json;
    try { const v = JSON.parse(String(raw ?? "{}")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

// OpenAI chat-completions body → Claude Messages API params.
export function toAnthropicRequest(body: Json, upstreamModel: string, defaultMaxTokens: number): Json {
    const system: string[] = [];
    const messages: { role: "user" | "assistant"; content: Json[] }[] = [];
    const push = (role: "user" | "assistant", blocks: Json[]) => {
        if (!blocks.length) return;
        const last = messages[messages.length - 1];
        if (last && last.role === role) last.content.push(...blocks);
        else messages.push({ role, content: blocks });
    };
    for (const m of Array.isArray(body.messages) ? body.messages : []) {
        const role = m?.role;
        if (role === "system" || role === "developer") {
            const t = textOf(m.content);
            if (t) system.push(t);
        } else if (role === "user") {
            push("user", userBlocks(m.content));
        } else if (role === "assistant") {
            const blocks: Json[] = [];
            const t = textOf(m.content);
            if (t.trim()) blocks.push({ type: "text", text: t });
            for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
                if (tc?.function?.name) blocks.push({ type: "tool_use", id: String(tc.id ?? `toolu_${Math.random().toString(36).slice(2)}`), name: tc.function.name, input: parseArgs(tc.function.arguments) });
            }
            push("assistant", blocks);
        } else if (role === "tool") {
            push("user", [{ type: "tool_result", tool_use_id: String(m.tool_call_id ?? ""), content: textOf(m.content) || "(empty)" }]);
        }
    }
    if (!messages.length) throw new AnthropicRequestError("\"messages\" needs at least one user message.");
    if (messages[0].role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(continuing)" }] });

    const params: Json = {
        model: upstreamModel,
        max_tokens: Math.max(1, Math.min(Number(body.max_completion_tokens ?? body.max_tokens) || defaultMaxTokens, 128_000)),
        messages,
    };
    if (system.length) params.system = system.join("\n\n");
    const stop = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((s: unknown) => typeof s === "string" && s.trim()) : [];
    if (stop.length) params.stop_sequences = stop.slice(0, 4);
    // Sampling parameters are left out: current Claude models reject them.
    const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t: any) => t?.type === "function" && t.function?.name);
    if (tools.length) {
        params.tools = tools.map((t: any) => ({ name: t.function.name, description: t.function.description ?? "", input_schema: t.function.parameters ?? { type: "object", properties: {} } }));
        const tc = body.tool_choice;
        if (tc === "required") params.tool_choice = { type: "any" };
        else if (tc === "none") params.tool_choice = { type: "none" };
        else if (tc && typeof tc === "object" && tc.function?.name) params.tool_choice = { type: "tool", name: tc.function.name };
    }
    if (typeof body.user === "string" && body.user) params.metadata = { user_id: body.user.slice(0, 256) };
    return params;
}

const usageOf = (u: any) => {
    const cached = Number(u?.cache_read_input_tokens ?? 0);
    const prompt = Number(u?.input_tokens ?? 0) + cached + Number(u?.cache_creation_input_tokens ?? 0);
    const completion = Number(u?.output_tokens ?? 0);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } };
};

// Claude message → OpenAI chat.completion JSON.
export function fromAnthropicMessage(msg: any, modelId: string): Json {
    const text = (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const toolCalls = (msg.content ?? []).filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    return {
        id: msg.id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: text || (toolCalls.length ? null : ""), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: FINISH[msg.stop_reason] ?? "stop" }],
        usage: usageOf(msg.usage),
    };
}

const jsonResponse = (status: number, body: Json) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type AnthropicClientFactory = (route: Route) => Pick<Anthropic, "messages">;
const defaultClient: AnthropicClientFactory = (route) => new Anthropic({ apiKey: route.apiKey, baseURL: route.baseUrl.replace(/\/v1\/?$/, "") });

// Calls Claude for one route; the result looks like an OpenAI-compatible HTTP response.
export async function callAnthropic(route: Route, body: Json, stream: boolean, signal: AbortSignal, modelId: string, makeClient: AnthropicClientFactory = defaultClient): Promise<Response> {
    let params: Json;
    try {
        params = toAnthropicRequest(body, route.upstreamModel, route.maxOutput ?? 8192);
    } catch (err) {
        return jsonResponse(400, { error: { message: err instanceof Error ? err.message : "Invalid request" } });
    }
    const client = makeClient(route);
    try {
        if (!stream) {
            const msg = await client.messages.create(params as any, { signal });
            return jsonResponse(200, fromAnthropicMessage(msg, modelId));
        }
        const events = client.messages.stream(params as any, { signal })[Symbol.asyncIterator]();
        // Wait for the first event, so a failure is still a proper HTTP error (and can fail over).
        const first = await events.next();
        const encoder = new TextEncoder();
        const sse = (o: Json) => encoder.encode(`data: ${JSON.stringify(o)}\n\n`);
        let id = "chatcmpl-claude";
        const created = Math.floor(Date.now() / 1000);
        const chunk = (delta: Json, finish: string | null = null) => ({ id, object: "chat.completion.chunk", created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] });
        const toolIndex = new Map<number, number>();
        let usage: any = {};
        let finish: string | null = null;
        const body2 = new ReadableStream<Uint8Array>({
            async start(controller) {
                const handle = (e: any) => {
                    switch (e.type) {
                        case "message_start":
                            id = e.message?.id ?? id;
                            usage = { ...(e.message?.usage ?? {}) };
                            controller.enqueue(sse(chunk({ role: "assistant", content: "" })));
                            break;
                        case "content_block_start":
                            if (e.content_block?.type === "tool_use") {
                                const idx = toolIndex.size;
                                toolIndex.set(e.index, idx);
                                controller.enqueue(sse(chunk({ tool_calls: [{ index: idx, id: e.content_block.id, type: "function", function: { name: e.content_block.name, arguments: "" } }] })));
                            }
                            break;
                        case "content_block_delta":
                            if (e.delta?.type === "text_delta" && e.delta.text) controller.enqueue(sse(chunk({ content: e.delta.text })));
                            else if (e.delta?.type === "input_json_delta" && toolIndex.has(e.index)) {
                                controller.enqueue(sse(chunk({ tool_calls: [{ index: toolIndex.get(e.index), function: { arguments: e.delta.partial_json ?? "" } }] })));
                            }
                            break;   // thinking is not part of the OpenAI format
                        case "message_delta":
                            if (e.delta?.stop_reason) finish = FINISH[e.delta.stop_reason] ?? "stop";
                            if (e.usage) usage = { ...usage, ...Object.fromEntries(Object.entries(e.usage).filter(([, v]) => v !== null && v !== undefined)) };
                            break;
                    }
                };
                try {
                    if (!first.done) handle(first.value);
                    while (true) {
                        const step = await events.next();
                        if (step.done) break;
                        handle(step.value);
                    }
                    controller.enqueue(sse(chunk({}, finish ?? "stop")));
                    // Token counts (what the request is charged from).
                    controller.enqueue(sse({ id, object: "chat.completion.chunk", created, model: modelId, choices: [], usage: usageOf(usage) }));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                } catch (err) {
                    controller.enqueue(sse({ error: { message: "The model stopped unexpectedly." } }));
                    controller.close();
                    if (!(err instanceof Anthropic.APIUserAbortError)) console.warn("[market-api] Claude stream failed:", err instanceof Error ? err.message : err);
                }
            },
        });
        return new Response(body2, { status: 200, headers: { "content-type": "text/event-stream" } });
    } catch (err) {
        if (err instanceof Anthropic.APIUserAbortError) throw err;
        if (err instanceof Anthropic.APIError && typeof err.status === "number") {
            return jsonResponse(err.status, { error: { message: err.message } });
        }
        throw err;   // network problems: the caller fails over
    }
}
