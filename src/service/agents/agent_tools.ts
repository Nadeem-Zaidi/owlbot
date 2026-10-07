import { ToolSource } from "../../interfaces/illm";
import { IVectorDb } from "../../interfaces/vectordb/ivector";
import { AgentCodeFunctionRow, AgentFunctionRow, AgentMcpServerRow, FunctionParam } from "../../repository/agent_repository";
import { runPython } from "../../protos/client";
import { EmbeddingProvider, createVectorSearchTool } from "../../tools/vector_tool";
import { ToolContext, ToolDefinition } from "../../types/type";
import { KnowledgeBase } from "../knowledge_base";
import { McpPool } from "./mcp_pool";
import { decryptSecret } from "./secrets";
import { assertPublicUrl } from "./url_guard";

const HTTP_TIMEOUT_MS = 15_000;
export const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_RESPONSE_BYTES = 200_000;

// ── Built-in tools ───────────────────────────────────────────────────────
// What the agent editor offers as checkboxes. `code_interpreter` is OpenAI's
// hosted sandbox, so it only has an effect on ChatGPT models.
export const BUILTIN_TOOLS = [
    { id: "search_knowledge_base", label: "Search knowledge base", description: "Finds relevant passages in the agent's documents." },
    { id: "read_document", label: "Read a full document", description: "Reads an entire document when a passage isn't enough." },
    { id: "list_documents", label: "List documents", description: "Lets the agent see which documents it can use." },
    { id: "current_datetime", label: "Current date & time", description: "For anything time-sensitive (deadlines, “today”)." },
    { id: "code_interpreter", label: "Code interpreter", description: "Runs Python for maths and data. ChatGPT models only." },
] as const;

export type BuiltinToolId = (typeof BUILTIN_TOOLS)[number]["id"];
export const BUILTIN_TOOL_IDS = new Set<string>(BUILTIN_TOOLS.map((t) => t.id));

// `alwaysTools`: tools every agent gets (e.g. creating documents in the side panel).
export type BuiltinDeps = { vectorDb: IVectorDb; embed: EmbeddingProvider; kb: KnowledgeBase; alwaysTools?: ToolDefinition[] };

function builtinTool(id: string, deps: BuiltinDeps, documentKeys: string[]): ToolDefinition | null {
    const inScope = (key: string) => !documentKeys.length || documentKeys.includes(key);
    switch (id) {
        case "search_knowledge_base":
            return createVectorSearchTool(deps.vectorDb, deps.embed, documentKeys);
        case "list_documents":
            return {
                name: "list_documents",
                description: "Lists the documents available to you in the knowledge base.",
                parameters: { type: "object", properties: {}, required: [] },
                execute: async (_args, ctx) => {
                    const docs = (await deps.kb.listDocuments(requireUser(ctx))).filter((d) => inScope(d.key));
                    return { documents: docs.map((d) => d.name), count: docs.length };
                },
            };
        case "read_document":
            return {
                name: "read_document",
                description: "Returns the full text of one document from the knowledge base. Use list_documents to see the names.",
                parameters: {
                    type: "object",
                    properties: { name: { type: "string", description: "Document file name, e.g. invoices.pdf" } },
                    required: ["name"],
                },
                execute: async (args, ctx) => {
                    const userId = requireUser(ctx);
                    const wanted = String(args.name ?? "").trim().toLowerCase();
                    const doc = (await deps.kb.listDocuments(userId))
                        .filter((d) => inScope(d.key))
                        .find((d) => d.name.toLowerCase() === wanted) ??
                        (await deps.kb.listDocuments(userId)).filter((d) => inScope(d.key)).find((d) => d.name.toLowerCase().includes(wanted));
                    if (!doc) throw new Error(`No document named "${args.name}" is available.`);
                    const text = await deps.kb.readDocument(userId, doc.key);
                    if (!text) throw new Error(`"${doc.name}" couldn't be read.`);
                    return { name: text.name, truncated: text.truncated, content: text.content };
                },
            };
        case "current_datetime":
            return {
                name: "current_datetime",
                description: "Returns the current date and time.",
                parameters: {
                    type: "object",
                    properties: { timezone: { type: "string", description: "IANA timezone, e.g. Asia/Kolkata (optional)" } },
                    required: [],
                },
                execute: async (args) => {
                    const now = new Date();
                    const tz = typeof args.timezone === "string" && args.timezone ? args.timezone : "UTC";
                    let local: string;
                    try {
                        local = now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" });
                    } catch {
                        local = now.toUTCString();
                    }
                    return { iso_utc: now.toISOString(), local, timezone: tz };
                },
            };
        default:
            return null; // code_interpreter is a hosted tool, not a function
    }
}

function requireUser(ctx: ToolContext): string {
    if (!ctx.userId) throw new Error("This tool needs a signed-in user.");
    return ctx.userId;
}

// ── HTTP functions ───────────────────────────────────────────────────────
export function paramsToSchema(params: FunctionParam[]): ToolDefinition["parameters"] {
    const properties: Record<string, { type: string; description?: string }> = {};
    for (const p of params) properties[p.name] = { type: p.type, ...(p.description ? { description: p.description } : {}) };
    return { type: "object", properties, required: params.filter((p) => p.required).map((p) => p.name) };
}

export type HttpCallResult = { status: number; ok: boolean; body: unknown; durationMs: number };

// Fills {placeholders} in the URL; other arguments go in the query string
// (GET/DELETE) or a JSON body (POST/PUT/PATCH).
export async function callHttpFunction(fn: Pick<AgentFunctionRow, "method" | "url" | "headers" | "parameters">, args: Record<string, unknown>): Promise<HttpCallResult> {
    const used = new Set<string>();
    const filled = fn.url.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, name: string) => {
        used.add(name);
        const v = args[name];
        if (v === undefined || v === null || v === "") throw new Error(`Missing value for "${name}"`);
        return encodeURIComponent(String(v));
    });
    const url = await assertPublicUrl(filled);
    const rest = Object.fromEntries(Object.entries(args).filter(([k, v]) => !used.has(k) && v !== undefined));

    const method = fn.method.toUpperCase();
    const headers: Record<string, string> = { Accept: "application/json, text/plain;q=0.9, */*;q=0.5" };
    for (const h of fn.headers) if (h.key) headers[h.key] = h.secret ? decryptSecret(h.value) : h.value;

    let body: string | undefined;
    if (["POST", "PUT", "PATCH"].includes(method)) {
        body = JSON.stringify(rest);
        headers["Content-Type"] ??= "application/json";
    } else {
        for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, String(v));
    }

    const started = Date.now();
    // redirect: "manual" — a redirect could point at a private address the
    // URL check above never saw.
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const raw = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_RESPONSE_BYTES).toString("utf-8");
    let parsed: unknown = raw;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // not JSON — keep the text
    }
    if (res.status >= 300 && res.status < 400) parsed = { redirect: res.headers.get("location"), note: "Redirects aren't followed." };
    return { status: res.status, ok: res.ok, body: parsed, durationMs: Date.now() - started };
}

export function httpFunctionTool(fn: AgentFunctionRow): ToolDefinition {
    return {
        name: fn.name,
        description: fn.description || `Calls ${fn.method} ${fn.url}`,
        parameters: paramsToSchema(fn.parameters),
        execute: async (args) => {
            const result = await callHttpFunction(fn, args);
            if (!result.ok) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 2000)}`);
            return result.body;
        },
    };
}

// ── Code functions (owner-written Python, run by the Python gRPC service) ──
export function decryptCodeSecrets(fn: Pick<AgentCodeFunctionRow, "secrets">): Record<string, string> {
    return Object.fromEntries(fn.secrets.map((s) => [s.key, decryptSecret(s.value)]));
}

export function codeFunctionTool(fn: AgentCodeFunctionRow): ToolDefinition {
    return {
        name: fn.name,
        description: fn.description || `Runs the Python function ${fn.name}`,
        parameters: paramsToSchema(fn.parameters),
        execute: async (args) => {
            const r = await runPython(fn.code, args, decryptCodeSecrets(fn), fn.timeout_ms);
            if (!r.ok) throw new Error(`${r.error ?? "The function failed"}${r.stdout ? `\nOutput before the error:\n${r.stdout.slice(-2000)}` : ""}`);
            return r.stdout ? { result: r.result, printed: r.stdout.slice(-4000) } : r.result;
        },
    };
}

// ── MCP tools ────────────────────────────────────────────────────────────
// Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for both providers, and must not
// collide across servers, so each is prefixed with its server's name.
export function mcpToolName(serverName: string, toolName: string): string {
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "mcp";
    return `${slug(serverName).slice(0, 20)}__${slug(toolName)}`.slice(0, 64);
}

function mcpTools(server: AgentMcpServerRow, pool: McpPool): ToolDefinition[] {
    const token = server.auth_token ? decryptSecret(server.auth_token) : null;
    return server.tools.filter((t) => t.enabled).map((t) => {
        const schema = (t.inputSchema ?? {}) as Record<string, any>;
        return {
            name: mcpToolName(server.name, t.name),
            description: `[${server.name}] ${t.description ?? t.name}`.slice(0, 1024),
            parameters: { ...schema, type: "object", properties: schema.properties ?? {}, required: schema.required ?? [] } as ToolDefinition["parameters"],
            execute: (args: Record<string, any>) => pool.callTool(server.id, { url: server.url, token }, t.name, args),
        };
    });
}

// ── The agent's tool set ─────────────────────────────────────────────────
export class AgentToolSet implements ToolSource {
    private byName = new Map<string, ToolDefinition>();

    constructor(tools: ToolDefinition[]) {
        for (const t of tools) if (!this.byName.has(t.name)) this.byName.set(t.name, t);
    }

    getAll(): ToolDefinition[] {
        return [...this.byName.values()];
    }

    async executeTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<any> {
        const tool = this.byName.get(name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        const out = await tool.execute(args, ctx);
        // Keep huge results from flooding the context window.
        const text = typeof out === "string" ? out : JSON.stringify(out);
        return text.length > MAX_TOOL_OUTPUT_CHARS ? text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n…[truncated]" : out;
    }
}

export function buildAgentToolSet(
    agent: { builtin_tools: string[]; document_keys: string[] },
    functions: AgentFunctionRow[],
    servers: AgentMcpServerRow[],
    deps: BuiltinDeps,
    pool: McpPool,
    codeFunctions: AgentCodeFunctionRow[] = [],
): AgentToolSet {
    const tools: ToolDefinition[] = [];
    for (const id of agent.builtin_tools) {
        const t = builtinTool(id, deps, agent.document_keys);
        if (t) tools.push(t);
    }
    for (const fn of functions) if (fn.enabled) tools.push(httpFunctionTool(fn));
    for (const fn of codeFunctions) if (fn.enabled) tools.push(codeFunctionTool(fn));
    for (const s of servers) tools.push(...mcpTools(s, pool));
    tools.push(...(deps.alwaysTools ?? []));
    return new AgentToolSet(tools);
}
