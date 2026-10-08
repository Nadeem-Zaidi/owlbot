import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type FunctionParam = {
    name: string;
    type: "string" | "number" | "integer" | "boolean";
    description?: string;
    required?: boolean;
};

// `value` is encrypted when `secret` is true.
export type FunctionHeader = { key: string; value: string; secret: boolean };

export type McpToolInfo = {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    enabled: boolean;
};

// A Markdown file attached to an agent; its text is added to the instructions.
export type InstructionFile = { name: string; content: string; enabled: boolean };

export type AgentRow = {
    id: string;
    user_id: string;
    name: string;
    icon: string;
    description: string;
    instructions: string;
    provider: string | null;
    model: string | null;
    builtin_tools: string[];
    document_keys: string[];
    starters: string[];
    instruction_files: InstructionFile[];
    // Which of the owner's skills the agent may load.
    skill_mode: "all" | "selected" | "none";
    skill_ids: string[];
    created_at: Date;
    updated_at: Date;
};

export type AgentFunctionRow = {
    id: string;
    agent_id: string;
    name: string;
    description: string;
    method: string;
    url: string;
    parameters: FunctionParam[];
    headers: FunctionHeader[];
    enabled: boolean;
    created_at: Date;
};

export type AgentMcpServerRow = {
    id: string;
    agent_id: string;
    name: string;
    url: string;
    auth_token: string | null; // encrypted
    tools: McpToolInfo[];
    created_at: Date;
    updated_at: Date;
};

// An owner-written Python function the agent can call. Secret values are encrypted.
export type CodeSecret = { key: string; value: string };

export type AgentCodeFunctionRow = {
    id: string;
    agent_id: string;
    name: string;
    description: string;
    code: string;
    parameters: FunctionParam[];
    secrets: CodeSecret[];
    timeout_ms: number;
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
};

export type CodeFunctionInput = Pick<AgentCodeFunctionRow, "name" | "description" | "code" | "parameters" | "secrets" | "timeout_ms" | "enabled">;

export type AgentScheduleRow = {
    id: string;
    agent_id: string;
    user_id: string;
    name: string;
    prompt: string;
    frequency: "hourly" | "daily" | "weekdays" | "weekly";
    interval_hours: number | null;
    time_of_day: string | null;
    weekday: number | null;
    timezone: string;
    deliver_whatsapp: boolean;
    enabled: boolean;
    session_id: string | null;
    next_run_at: Date | null;
    last_run_at: Date | null;
    last_status: string | null;
    created_at: Date;
};

export type AgentRunRow = {
    id: number;
    schedule_id: string | null;
    agent_id: string;
    session_id: string | null;
    status: "running" | "succeeded" | "failed";
    output: string | null;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
};

export type AgentInput = Pick<AgentRow, "name" | "icon" | "description" | "instructions" | "provider" | "model" | "builtin_tools" | "document_keys" | "starters" | "instruction_files">
    // Omitted (older clients) → unchanged on update, "all" on create.
    & { skill_mode?: AgentRow["skill_mode"]; skill_ids?: string[] };
export type FunctionInput = Pick<AgentFunctionRow, "name" | "description" | "method" | "url" | "parameters" | "headers" | "enabled">;
export type ScheduleInput = Pick<AgentScheduleRow, "name" | "prompt" | "frequency" | "interval_hours" | "time_of_day" | "weekday" | "timezone" | "deliver_whatsapp" | "enabled">;

const json = (v: unknown) => JSON.stringify(v ?? []);

// All SQL for agents. Every read and write is scoped to the owning user.
export class AgentRepository {
    constructor(private db: IDatabaseAdapter) {}

    // ── agents ──
    async listAgents(userId: string): Promise<(AgentRow & { function_count: number; mcp_count: number; code_function_count: number; schedule_count: number })[]> {
        const { rows } = await this.db.query(
            `SELECT a.*,
                    (SELECT count(*)::int FROM agent_functions f WHERE f.agent_id = a.id) AS function_count,
                    (SELECT count(*)::int FROM agent_mcp_servers m WHERE m.agent_id = a.id) AS mcp_count,
                    (SELECT count(*)::int FROM agent_code_functions c WHERE c.agent_id = a.id) AS code_function_count,
                    (SELECT count(*)::int FROM agent_schedules s WHERE s.agent_id = a.id AND s.enabled) AS schedule_count
             FROM agents a WHERE a.user_id = $1 ORDER BY a.updated_at DESC`,
            [userId]
        );
        return rows;
    }

    async getAgent(id: string, userId: string): Promise<AgentRow | null> {
        const { rows } = await this.db.query<AgentRow>(`SELECT * FROM agents WHERE id = $1 AND user_id = $2`, [id, userId]);
        return rows[0] ?? null;
    }

    async createAgent(userId: string, a: AgentInput): Promise<AgentRow> {
        const { rows } = await this.db.query<AgentRow>(
            `INSERT INTO agents (id, user_id, name, icon, description, instructions, provider, model, builtin_tools, document_keys, starters, instruction_files, skill_mode, skill_ids)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [randomUUID(), userId, a.name, a.icon, a.description, a.instructions, a.provider, a.model,
             json(a.builtin_tools), json(a.document_keys), json(a.starters), json(a.instruction_files), a.skill_mode ?? "all", json(a.skill_ids ?? [])]
        );
        return rows[0];
    }

    async updateAgent(id: string, userId: string, a: AgentInput): Promise<AgentRow | null> {
        const { rows } = await this.db.query<AgentRow>(
            `UPDATE agents SET name=$3, icon=$4, description=$5, instructions=$6, provider=$7, model=$8,
                    builtin_tools=$9, document_keys=$10, starters=$11, instruction_files=$12,
                    skill_mode=COALESCE($13, skill_mode), skill_ids=COALESCE($14::jsonb, skill_ids), updated_at=now()
             WHERE id=$1 AND user_id=$2 RETURNING *`,
            [id, userId, a.name, a.icon, a.description, a.instructions, a.provider, a.model,
             json(a.builtin_tools), json(a.document_keys), json(a.starters), json(a.instruction_files),
             a.skill_mode ?? null, a.skill_ids ? json(a.skill_ids) : null]
        );
        return rows[0] ?? null;
    }

    // Functions, MCP servers, schedules and runs go with it (ON DELETE CASCADE);
    // its chats stay, unlinked from the agent.
    async deleteAgent(id: string, userId: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM agents WHERE id=$1 AND user_id=$2`, [id, userId]);
        return r.rowCount > 0;
    }

    private async touchAgent(agentId: string) {
        await this.db.query(`UPDATE agents SET updated_at = now() WHERE id = $1`, [agentId]);
    }

    // ── HTTP functions ──
    async listFunctions(agentId: string): Promise<AgentFunctionRow[]> {
        const { rows } = await this.db.query<AgentFunctionRow>(`SELECT * FROM agent_functions WHERE agent_id=$1 ORDER BY created_at`, [agentId]);
        return rows;
    }

    async getFunction(agentId: string, id: string): Promise<AgentFunctionRow | null> {
        const { rows } = await this.db.query<AgentFunctionRow>(`SELECT * FROM agent_functions WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        return rows[0] ?? null;
    }

    async createFunction(agentId: string, f: FunctionInput): Promise<AgentFunctionRow> {
        const { rows } = await this.db.query<AgentFunctionRow>(
            `INSERT INTO agent_functions (id, agent_id, name, description, method, url, parameters, headers, enabled)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [randomUUID(), agentId, f.name, f.description, f.method, f.url, json(f.parameters), json(f.headers), f.enabled]
        );
        await this.touchAgent(agentId);
        return rows[0];
    }

    async updateFunction(agentId: string, id: string, f: FunctionInput): Promise<AgentFunctionRow | null> {
        const { rows } = await this.db.query<AgentFunctionRow>(
            `UPDATE agent_functions SET name=$3, description=$4, method=$5, url=$6, parameters=$7, headers=$8, enabled=$9
             WHERE agent_id=$1 AND id=$2 RETURNING *`,
            [agentId, id, f.name, f.description, f.method, f.url, json(f.parameters), json(f.headers), f.enabled]
        );
        await this.touchAgent(agentId);
        return rows[0] ?? null;
    }

    async deleteFunction(agentId: string, id: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM agent_functions WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        await this.touchAgent(agentId);
        return r.rowCount > 0;
    }

    // ── code functions ──
    async listCodeFunctions(agentId: string): Promise<AgentCodeFunctionRow[]> {
        const { rows } = await this.db.query<AgentCodeFunctionRow>(`SELECT * FROM agent_code_functions WHERE agent_id=$1 ORDER BY created_at`, [agentId]);
        return rows;
    }

    async getCodeFunction(agentId: string, id: string): Promise<AgentCodeFunctionRow | null> {
        const { rows } = await this.db.query<AgentCodeFunctionRow>(`SELECT * FROM agent_code_functions WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        return rows[0] ?? null;
    }

    async createCodeFunction(agentId: string, f: CodeFunctionInput): Promise<AgentCodeFunctionRow> {
        const { rows } = await this.db.query<AgentCodeFunctionRow>(
            `INSERT INTO agent_code_functions (id, agent_id, name, description, code, parameters, secrets, timeout_ms, enabled)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [randomUUID(), agentId, f.name, f.description, f.code, json(f.parameters), json(f.secrets), f.timeout_ms, f.enabled]
        );
        await this.touchAgent(agentId);
        return rows[0];
    }

    async updateCodeFunction(agentId: string, id: string, f: CodeFunctionInput): Promise<AgentCodeFunctionRow | null> {
        const { rows } = await this.db.query<AgentCodeFunctionRow>(
            `UPDATE agent_code_functions SET name=$3, description=$4, code=$5, parameters=$6, secrets=$7, timeout_ms=$8, enabled=$9, updated_at=now()
             WHERE agent_id=$1 AND id=$2 RETURNING *`,
            [agentId, id, f.name, f.description, f.code, json(f.parameters), json(f.secrets), f.timeout_ms, f.enabled]
        );
        await this.touchAgent(agentId);
        return rows[0] ?? null;
    }

    async deleteCodeFunction(agentId: string, id: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM agent_code_functions WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        await this.touchAgent(agentId);
        return r.rowCount > 0;
    }

    // ── MCP servers ──
    async listMcpServers(agentId: string): Promise<AgentMcpServerRow[]> {
        const { rows } = await this.db.query<AgentMcpServerRow>(`SELECT * FROM agent_mcp_servers WHERE agent_id=$1 ORDER BY created_at`, [agentId]);
        return rows;
    }

    async getMcpServer(agentId: string, id: string): Promise<AgentMcpServerRow | null> {
        const { rows } = await this.db.query<AgentMcpServerRow>(`SELECT * FROM agent_mcp_servers WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        return rows[0] ?? null;
    }

    async createMcpServer(agentId: string, s: { name: string; url: string; auth_token: string | null; tools: McpToolInfo[] }): Promise<AgentMcpServerRow> {
        const { rows } = await this.db.query<AgentMcpServerRow>(
            `INSERT INTO agent_mcp_servers (id, agent_id, name, url, auth_token, tools) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [randomUUID(), agentId, s.name, s.url, s.auth_token, json(s.tools)]
        );
        await this.touchAgent(agentId);
        return rows[0];
    }

    async updateMcpServer(agentId: string, id: string, s: { name: string; url: string; auth_token: string | null; tools: McpToolInfo[] }): Promise<AgentMcpServerRow | null> {
        const { rows } = await this.db.query<AgentMcpServerRow>(
            `UPDATE agent_mcp_servers SET name=$3, url=$4, auth_token=$5, tools=$6, updated_at=now()
             WHERE agent_id=$1 AND id=$2 RETURNING *`,
            [agentId, id, s.name, s.url, s.auth_token, json(s.tools)]
        );
        await this.touchAgent(agentId);
        return rows[0] ?? null;
    }

    async deleteMcpServer(agentId: string, id: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM agent_mcp_servers WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        await this.touchAgent(agentId);
        return r.rowCount > 0;
    }

    // ── schedules ──
    async listSchedules(agentId: string): Promise<AgentScheduleRow[]> {
        const { rows } = await this.db.query<AgentScheduleRow>(`SELECT * FROM agent_schedules WHERE agent_id=$1 ORDER BY created_at`, [agentId]);
        return rows;
    }

    async getSchedule(agentId: string, id: string): Promise<AgentScheduleRow | null> {
        const { rows } = await this.db.query<AgentScheduleRow>(`SELECT * FROM agent_schedules WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        return rows[0] ?? null;
    }

    async createSchedule(agentId: string, userId: string, s: ScheduleInput, nextRunAt: Date | null): Promise<AgentScheduleRow> {
        const { rows } = await this.db.query<AgentScheduleRow>(
            `INSERT INTO agent_schedules (id, agent_id, user_id, name, prompt, frequency, interval_hours, time_of_day, weekday, timezone, deliver_whatsapp, enabled, next_run_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
            [randomUUID(), agentId, userId, s.name, s.prompt, s.frequency, s.interval_hours, s.time_of_day, s.weekday, s.timezone,
             s.deliver_whatsapp, s.enabled, nextRunAt]
        );
        return rows[0];
    }

    async updateSchedule(agentId: string, id: string, s: ScheduleInput, nextRunAt: Date | null): Promise<AgentScheduleRow | null> {
        const { rows } = await this.db.query<AgentScheduleRow>(
            `UPDATE agent_schedules SET name=$3, prompt=$4, frequency=$5, interval_hours=$6, time_of_day=$7, weekday=$8,
                    timezone=$9, deliver_whatsapp=$10, enabled=$11, next_run_at=$12
             WHERE agent_id=$1 AND id=$2 RETURNING *`,
            [agentId, id, s.name, s.prompt, s.frequency, s.interval_hours, s.time_of_day, s.weekday, s.timezone,
             s.deliver_whatsapp, s.enabled, nextRunAt]
        );
        return rows[0] ?? null;
    }

    async deleteSchedule(agentId: string, id: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM agent_schedules WHERE agent_id=$1 AND id=$2`, [agentId, id]);
        return r.rowCount > 0;
    }

    async setScheduleSession(id: string, sessionId: string): Promise<void> {
        await this.db.query(`UPDATE agent_schedules SET session_id=$2 WHERE id=$1`, [id, sessionId]);
    }

    // For the scheduler (not user-scoped).
    async dueSchedules(limit: number): Promise<AgentScheduleRow[]> {
        const { rows } = await this.db.query<AgentScheduleRow>(
            `SELECT * FROM agent_schedules WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()
             ORDER BY next_run_at LIMIT $1`,
            [limit]
        );
        return rows;
    }

    // Moves next_run_at forward only if nobody else already did — a cheap
    // claim, so a schedule can't run twice for the same slot.
    async claimSchedule(id: string, expectedNext: Date, newNext: Date): Promise<boolean> {
        const r = await this.db.query(
            `UPDATE agent_schedules SET next_run_at=$3, last_run_at=now() WHERE id=$1 AND next_run_at=$2`,
            [id, expectedNext, newNext]
        );
        return r.rowCount > 0;
    }

    async setScheduleStatus(id: string, status: string): Promise<void> {
        await this.db.query(`UPDATE agent_schedules SET last_status=$2 WHERE id=$1`, [id, status]);
    }

    // ── runs ──
    async startRun(agentId: string, scheduleId: string | null, sessionId: string | null): Promise<number> {
        const { rows } = await this.db.query<{ id: number }>(
            `INSERT INTO agent_runs (agent_id, schedule_id, session_id, status) VALUES ($1,$2,$3,'running') RETURNING id`,
            [agentId, scheduleId, sessionId]
        );
        return rows[0].id;
    }

    async finishRun(id: number, status: "succeeded" | "failed", output: string | null, error: string | null): Promise<void> {
        await this.db.query(
            `UPDATE agent_runs SET status=$2, output=$3, error=$4, finished_at=now() WHERE id=$1`,
            [id, status, output, error]
        );
    }

    async listRuns(agentId: string, limit = 20): Promise<(AgentRunRow & { schedule_name: string | null })[]> {
        const { rows } = await this.db.query(
            `SELECT r.*, s.name AS schedule_name FROM agent_runs r
             LEFT JOIN agent_schedules s ON s.id = r.schedule_id
             WHERE r.agent_id=$1 ORDER BY r.started_at DESC LIMIT $2`,
            [agentId, limit]
        );
        return rows;
    }

    // ── sessions ──
    async attachSession(sessionId: string, agentId: string, userId: string): Promise<void> {
        await this.db.query(
            `UPDATE sessions SET agent_id=$2 WHERE id=$1 AND userid=$3 AND agent_id IS NULL`,
            [sessionId, agentId, userId]
        );
    }

    async sessionAgentId(sessionId: string, userId: string): Promise<string | null> {
        const { rows } = await this.db.query<{ agent_id: string | null }>(
            `SELECT agent_id FROM sessions WHERE id=$1 AND userid=$2`, [sessionId, userId]
        );
        return rows[0]?.agent_id ?? null;
    }
}
