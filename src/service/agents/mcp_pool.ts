import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { McpToolInfo } from "../../repository/agent_repository";
import { assertPublicUrl } from "./url_guard";

// Connects to remote MCP servers (Streamable HTTP, falling back to the older
// SSE transport), discovers their tools and calls them. Only remote http(s)
// servers — no stdio, which would start processes on this machine.

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const IDLE_CLOSE_MS = 5 * 60_000;
const MAX_RESULT_CHARS = 20_000;

export type McpTarget = { url: string; token?: string | null };

function headers(token?: string | null): Record<string, string> {
    return token ? { Authorization: `Bearer ${token}` } : {};
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
    ]);
}

export async function connectMcp(target: McpTarget): Promise<Client> {
    const url = await assertPublicUrl(target.url);
    const requestInit = { headers: headers(target.token) };
    const client = new Client({ name: "owlbot", version: "1.0.0" });
    try {
        await withTimeout(client.connect(new StreamableHTTPClientTransport(url, { requestInit })), CONNECT_TIMEOUT_MS, "Connecting");
        return client;
    } catch (streamErr) {
        // Older servers only speak SSE.
        const sseClient = new Client({ name: "owlbot", version: "1.0.0" });
        try {
            await withTimeout(sseClient.connect(new SSEClientTransport(url, { requestInit })), CONNECT_TIMEOUT_MS, "Connecting");
            return sseClient;
        } catch {
            const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
            throw new Error(/401|403|unauthori[sz]ed|forbidden/i.test(msg)
                ? "The server rejected the credentials — check the access token."
                : `Couldn't connect to the MCP server: ${msg}`);
        }
    }
}

async function listAllTools(client: Client): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
        const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), CALL_TIMEOUT_MS, "Listing tools");
        for (const t of page.tools) {
            tools.push({
                name: t.name,
                description: t.description ?? "",
                inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
                enabled: true,
            });
        }
        cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
}

/** Connects once and returns the server's tools (used by "Connect" in the UI). */
export async function discoverMcpTools(target: McpTarget): Promise<McpToolInfo[]> {
    const client = await connectMcp(target);
    try {
        return await listAllTools(client);
    } finally {
        await client.close().catch(() => {});
    }
}

// MCP results are content blocks; the model gets them as one string.
export function mcpResultToText(result: any): string {
    const parts: string[] = [];
    for (const block of result?.content ?? []) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "resource") parts.push(block.resource?.text ?? `[resource: ${block.resource?.uri ?? "unknown"}]`);
        else if (block.type === "resource_link") parts.push(`[link: ${block.uri}]`);
        else parts.push(`[${block.type} content omitted]`);
    }
    if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent));
    const text = parts.join("\n").trim() || "(no output)";
    return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + "\n…[truncated]" : text;
}

// Keeps one open connection per server and closes idle ones.
export class McpPool {
    private clients = new Map<string, { client: Promise<Client>; key: string; lastUsed: number }>();
    private sweeper = setInterval(() => this.closeIdle(), 60_000);

    constructor() {
        this.sweeper.unref();
    }

    async callTool(serverId: string, target: McpTarget, toolName: string, args: Record<string, unknown>): Promise<string> {
        const client = await this.get(serverId, target);
        try {
            const result = await withTimeout(client.callTool({ name: toolName, arguments: args }), CALL_TIMEOUT_MS, `Tool "${toolName}"`);
            const text = mcpResultToText(result);
            if ((result as any)?.isError) throw new Error(text);
            return text;
        } catch (err) {
            // A dead connection shouldn't stick around for the next call.
            this.drop(serverId);
            throw err;
        }
    }

    private async get(serverId: string, target: McpTarget): Promise<Client> {
        const key = `${target.url}|${target.token ?? ""}`;
        const existing = this.clients.get(serverId);
        if (existing && existing.key === key) {
            existing.lastUsed = Date.now();
            return existing.client;
        }
        if (existing) this.drop(serverId);
        const client = connectMcp(target);
        this.clients.set(serverId, { client, key, lastUsed: Date.now() });
        client.catch(() => this.clients.delete(serverId));
        return client;
    }

    drop(serverId: string) {
        const entry = this.clients.get(serverId);
        this.clients.delete(serverId);
        entry?.client.then((c) => c.close()).catch(() => {});
    }

    private closeIdle() {
        const now = Date.now();
        for (const [id, entry] of this.clients) {
            if (now - entry.lastUsed > IDLE_CLOSE_MS) this.drop(id);
        }
    }
}
