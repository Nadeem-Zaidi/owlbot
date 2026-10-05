import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { AgentCodeFunctionRow, AgentFunctionRow, CodeFunctionInput, FunctionInput } from "./agent_repository";

export type NativeProvider = "anthropic" | "openai";

export type NativeMcpServer = { name: string; url: string };

// Our copy of an agent that lives in Claude Managed Agents or the OpenAI
// Agents API. remote_agent_id points at the provider's object.
export interface NativeAgentRow {
    id: string;
    user_id: string;
    provider: NativeProvider;
    remote_agent_id: string | null;
    remote_version: number | null;
    name: string;
    icon: string;
    description: string;
    instructions: string;
    model: string;
    web_search: boolean;
    code_sandbox: boolean;
    knowledge_base: boolean;
    browser: boolean;          // OpenAI computer use (hosted browser)
    mcp_servers: NativeMcpServer[];
    created_at: Date;
    updated_at: Date;
}

export type NativeAgentInput = Pick<NativeAgentRow,
    "provider" | "name" | "icon" | "description" | "instructions" | "model" | "web_search" | "code_sandbox" | "knowledge_base" | "browser" | "mcp_servers">;

export class NativeAgentRepository {
    constructor(private db: IDatabaseAdapter) {}

    async list(userId: string): Promise<(NativeAgentRow & { function_count: number; code_function_count: number })[]> {
        const { rows } = await this.db.query<NativeAgentRow & { function_count: number; code_function_count: number }>(
            `SELECT a.*,
                    (SELECT count(*)::int FROM native_agent_functions f WHERE f.agent_id = a.id) AS function_count,
                    (SELECT count(*)::int FROM native_agent_code_functions c WHERE c.agent_id = a.id) AS code_function_count
             FROM native_agents a WHERE a.user_id = $1 ORDER BY a.updated_at DESC`, [userId]);
        return rows;
    }

    async get(id: string, userId: string): Promise<NativeAgentRow | null> {
        const { rows } = await this.db.query<NativeAgentRow>(
            `SELECT * FROM native_agents WHERE id = $1 AND user_id = $2`, [id, userId]);
        return rows[0] ?? null;
    }

    async create(userId: string, a: NativeAgentInput, remoteId: string, remoteVersion: number | null): Promise<NativeAgentRow> {
        const { rows } = await this.db.query<NativeAgentRow>(
            `INSERT INTO native_agents (id, user_id, provider, remote_agent_id, remote_version, name, icon, description, instructions, model, web_search, code_sandbox, knowledge_base, mcp_servers, browser)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [randomUUID(), userId, a.provider, remoteId, remoteVersion, a.name, a.icon, a.description, a.instructions, a.model,
                a.web_search, a.code_sandbox, a.knowledge_base, JSON.stringify(a.mcp_servers), a.browser]
        );
        return rows[0];
    }

    async update(id: string, userId: string, a: Omit<NativeAgentInput, "provider">, remoteVersion: number | null): Promise<NativeAgentRow | null> {
        const { rows } = await this.db.query<NativeAgentRow>(
            `UPDATE native_agents SET name=$3, icon=$4, description=$5, instructions=$6, model=$7, web_search=$8, code_sandbox=$9,
                    knowledge_base=$10, mcp_servers=$11, remote_version=$12, browser=$13, updated_at=now()
             WHERE id=$1 AND user_id=$2 RETURNING *`,
            [id, userId, a.name, a.icon, a.description, a.instructions, a.model, a.web_search, a.code_sandbox, a.knowledge_base,
                JSON.stringify(a.mcp_servers), remoteVersion, a.browser]
        );
        return rows[0] ?? null;
    }

    async delete(id: string, userId: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM native_agents WHERE id = $1 AND user_id = $2`, [id, userId]);
        return r.rowCount > 0;
    }

    async setRemoteVersion(id: string, version: number | null): Promise<void> {
        await this.db.query(`UPDATE native_agents SET remote_version = COALESCE($2, remote_version), updated_at = now() WHERE id = $1`, [id, version]);
    }

    // ── HTTP functions (same shape as agent_functions) ──
    async listFunctions(agentId: string): Promise<AgentFunctionRow[]> {
        const { rows } = await this.db.query<AgentFunctionRow>(`SELECT * FROM native_agent_functions WHERE agent_id=$1 ORDER BY created_at`, [agentId]);
        return rows;
    }

    async getFunction(agentId: string, id: string): Promise<AgentFunctionRow | null> {
        const { rows } = await this.db.query<AgentFunctionRow>(`SELECT * FROM native_agent_functions WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        return rows[0] ?? null;
    }

    async createFunction(agentId: string, f: FunctionInput): Promise<AgentFunctionRow> {
        const { rows } = await this.db.query<AgentFunctionRow>(
            `INSERT INTO native_agent_functions (id, agent_id, name, description, method, url, parameters, headers, enabled)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [randomUUID(), agentId, f.name, f.description, f.method, f.url, JSON.stringify(f.parameters), JSON.stringify(f.headers), f.enabled]
        );
        return rows[0];
    }

    async updateFunction(agentId: string, id: string, f: FunctionInput): Promise<AgentFunctionRow | null> {
        const { rows } = await this.db.query<AgentFunctionRow>(
            `UPDATE native_agent_functions SET name=$3, description=$4, method=$5, url=$6, parameters=$7, headers=$8, enabled=$9
             WHERE agent_id=$1 AND id=$2 RETURNING *`,
            [agentId, id, f.name, f.description, f.method, f.url, JSON.stringify(f.parameters), JSON.stringify(f.headers), f.enabled]
        );
        return rows[0] ?? null;
    }

    async deleteFunction(agentId: string, id: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM native_agent_functions WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        return r.rowCount > 0;
    }

    // ── code functions (same shape as agent_code_functions) ──
    async listCodeFunctions(agentId: string): Promise<AgentCodeFunctionRow[]> {
        const { rows } = await this.db.query<AgentCodeFunctionRow>(`SELECT * FROM native_agent_code_functions WHERE agent_id=$1 ORDER BY created_at`, [agentId]);
        return rows;
    }

    async getCodeFunction(agentId: string, id: string): Promise<AgentCodeFunctionRow | null> {
        const { rows } = await this.db.query<AgentCodeFunctionRow>(`SELECT * FROM native_agent_code_functions WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        return rows[0] ?? null;
    }

    async createCodeFunction(agentId: string, f: CodeFunctionInput): Promise<AgentCodeFunctionRow> {
        const { rows } = await this.db.query<AgentCodeFunctionRow>(
            `INSERT INTO native_agent_code_functions (id, agent_id, name, description, code, parameters, secrets, timeout_ms, enabled)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [randomUUID(), agentId, f.name, f.description, f.code, JSON.stringify(f.parameters), JSON.stringify(f.secrets), f.timeout_ms, f.enabled]
        );
        return rows[0];
    }

    async updateCodeFunction(agentId: string, id: string, f: CodeFunctionInput): Promise<AgentCodeFunctionRow | null> {
        const { rows } = await this.db.query<AgentCodeFunctionRow>(
            `UPDATE native_agent_code_functions SET name=$3, description=$4, code=$5, parameters=$6, secrets=$7, timeout_ms=$8, enabled=$9, updated_at=now()
             WHERE agent_id=$1 AND id=$2 RETURNING *`,
            [agentId, id, f.name, f.description, f.code, JSON.stringify(f.parameters), JSON.stringify(f.secrets), f.timeout_ms, f.enabled]
        );
        return rows[0] ?? null;
    }

    async deleteCodeFunction(agentId: string, id: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM native_agent_code_functions WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        return r.rowCount > 0;
    }

    // ── which provider's agents are switched on ──
    async activeProvider(userId: string): Promise<NativeProvider | null> {
        const { rows } = await this.db.query<{ native_provider: NativeProvider | null }>(
            `SELECT native_provider FROM user_settings WHERE user_id = $1`, [userId]);
        return rows[0]?.native_provider ?? null;
    }

    async setActiveProvider(userId: string, provider: NativeProvider): Promise<void> {
        await this.db.query(
            `INSERT INTO user_settings (user_id, native_provider) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET native_provider = EXCLUDED.native_provider, updated_at = now()`,
            [userId, provider]
        );
    }

    // ── chats ──
    async sessionLink(sessionId: string, userId: string): Promise<{ native_agent_id: string | null; remote_session_id: string | null; agent_id: string | null; has_messages: boolean } | null> {
        const { rows } = await this.db.query<{ native_agent_id: string | null; remote_session_id: string | null; agent_id: string | null; has_messages: boolean }>(
            `SELECT s.native_agent_id, s.remote_session_id, s.agent_id,
                    EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id) AS has_messages
             FROM sessions s WHERE s.id = $1 AND s.userid = $2`,
            [sessionId, userId]
        );
        return rows[0] ?? null;
    }

    async attachSession(sessionId: string, userId: string, nativeAgentId: string): Promise<void> {
        await this.db.query(
            `UPDATE sessions SET native_agent_id = $3 WHERE id = $1 AND userid = $2 AND native_agent_id IS NULL AND agent_id IS NULL`,
            [sessionId, userId, nativeAgentId]
        );
    }

    async setRemoteSession(sessionId: string, remoteSessionId: string): Promise<void> {
        await this.db.query(`UPDATE sessions SET remote_session_id = $2 WHERE id = $1`, [sessionId, remoteSessionId]);
    }

    // Remote session ids of an agent's chats, so they can be cleaned up on delete.
    async remoteSessions(nativeAgentId: string): Promise<string[]> {
        const { rows } = await this.db.query<{ remote_session_id: string }>(
            `SELECT remote_session_id FROM sessions WHERE native_agent_id = $1 AND remote_session_id IS NOT NULL`, [nativeAgentId]);
        return rows.map((r) => r.remote_session_id);
    }

    // ── shared provider objects (e.g. the one Claude environment) ──
    async getState(key: string): Promise<string | null> {
        const { rows } = await this.db.query<{ value: string }>(`SELECT value FROM native_provider_state WHERE key = $1`, [key]);
        return rows[0]?.value ?? null;
    }

    async setState(key: string, value: string): Promise<void> {
        await this.db.query(
            `INSERT INTO native_provider_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [key, value]);
    }
}
