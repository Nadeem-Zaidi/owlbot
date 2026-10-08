import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import type { Flow, FlowRunState } from "../core/flows/flow_types";

// One step: which agent runs, and what it's told. `instruction` may use
// {{input}} (the pipeline's input) and {{previous}} (the last step's output).
// kind "native" = a provider agent (Claude Managed Agents / OpenAI Agents API);
// missing on older pipelines, which only had regular agents.
export type PipelineStepKind = "agent" | "native";
export type PipelineStep = { kind?: PipelineStepKind; agent_id: string; instruction: string };

export type PipelineRow = {
    id: string;
    user_id: string;
    name: string;
    description: string;
    steps: PipelineStep[];
    // Workflow graph (branches, conditions, approvals). Null on older
    // pipelines, which run their linear `steps`.
    flow: Flow | null;
    created_at: Date;
    updated_at: Date;
};

export type StepRunStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type PipelineRunStep = {
    kind?: PipelineStepKind;
    provider?: string;  // for provider agents: "anthropic" | "openai"
    agent_id: string;
    agent_name: string;
    agent_icon: string;
    status: StepRunStatus;
    prompt?: string;
    output?: string;
    error?: string;
    started_at?: string;
    finished_at?: string;
};

export type PipelineRunRow = {
    id: number;
    pipeline_id: string;
    user_id: string;
    // waiting: paused at an approval; rejected: an approval was declined
    // with nowhere to go; cancelled: stopped by the user.
    status: "running" | "waiting" | "succeeded" | "failed" | "rejected" | "cancelled";
    input: string;
    steps: PipelineRunStep[];
    state: FlowRunState | null;
    output: string | null;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
};

export type PipelineInput = Pick<PipelineRow, "name" | "description" | "steps"> & { flow?: Flow | null };

const json = (v: unknown) => JSON.stringify(v ?? []);

// SQL for pipelines; every query is scoped to the owning user.
export class PipelineRepository {
    constructor(private db: IDatabaseAdapter) {}

    async list(userId: string): Promise<(PipelineRow & { last_run_status: string | null; last_run_at: Date | null })[]> {
        const { rows } = await this.db.query(
            `SELECT p.*,
                    (SELECT status FROM pipeline_runs r WHERE r.pipeline_id = p.id ORDER BY r.started_at DESC LIMIT 1) AS last_run_status,
                    (SELECT started_at FROM pipeline_runs r WHERE r.pipeline_id = p.id ORDER BY r.started_at DESC LIMIT 1) AS last_run_at
             FROM pipelines p WHERE p.user_id = $1 ORDER BY p.updated_at DESC`,
            [userId]
        );
        return rows;
    }

    async get(id: string, userId: string): Promise<PipelineRow | null> {
        const { rows } = await this.db.query<PipelineRow>(`SELECT * FROM pipelines WHERE id=$1 AND user_id=$2`, [id, userId]);
        return rows[0] ?? null;
    }

    async create(userId: string, p: PipelineInput): Promise<PipelineRow> {
        const { rows } = await this.db.query<PipelineRow>(
            `INSERT INTO pipelines (id, user_id, name, description, steps, flow) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [randomUUID(), userId, p.name, p.description, json(p.steps), p.flow ? JSON.stringify(p.flow) : null]
        );
        return rows[0];
    }

    async update(id: string, userId: string, p: PipelineInput): Promise<PipelineRow | null> {
        const { rows } = await this.db.query<PipelineRow>(
            `UPDATE pipelines SET name=$3, description=$4, steps=$5, flow=$6, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
            [id, userId, p.name, p.description, json(p.steps), p.flow ? JSON.stringify(p.flow) : null]
        );
        return rows[0] ?? null;
    }

    async remove(id: string, userId: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM pipelines WHERE id=$1 AND user_id=$2`, [id, userId]);
        return r.rowCount > 0;
    }

    async startRun(pipelineId: string, userId: string, input: string, steps: PipelineRunStep[], state: FlowRunState | null = null): Promise<PipelineRunRow> {
        const { rows } = await this.db.query<PipelineRunRow>(
            `INSERT INTO pipeline_runs (pipeline_id, user_id, status, input, steps, state) VALUES ($1,$2,'running',$3,$4,$5) RETURNING *`,
            [pipelineId, userId, input, json(steps), state ? JSON.stringify(state) : null]
        );
        return rows[0];
    }

    // ── workflow runs ──
    async saveFlowRun(runId: number, steps: unknown[], state: FlowRunState): Promise<void> {
        await this.db.query(`UPDATE pipeline_runs SET steps=$2, state=$3 WHERE id=$1`, [runId, json(steps), JSON.stringify(state)]);
    }

    async pauseRun(runId: number, steps: unknown[], state: FlowRunState): Promise<void> {
        await this.db.query(`UPDATE pipeline_runs SET status='waiting', steps=$2, state=$3 WHERE id=$1`, [runId, json(steps), JSON.stringify(state)]);
    }

    // Takes a waiting run for this decision — atomic, so two clicks (or two
    // servers) can't both continue it.
    async claimWaiting(runId: number, userId: string): Promise<PipelineRunRow | null> {
        const { rows } = await this.db.query<PipelineRunRow>(
            `UPDATE pipeline_runs SET status='running' WHERE id=$1 AND user_id=$2 AND status='waiting' RETURNING *`, [runId, userId]);
        return rows[0] ?? null;
    }

    async endRun(runId: number, status: PipelineRunRow["status"], steps: unknown[], output: string | null, error: string | null, state?: FlowRunState): Promise<void> {
        await this.db.query(
            `UPDATE pipeline_runs SET status=$2, steps=$3, output=$4, error=$5, state=COALESCE($6, state), finished_at=now() WHERE id=$1`,
            [runId, status, json(steps), output, error, state ? JSON.stringify(state) : null]
        );
    }

    async cancelRun(runId: number, userId: string): Promise<PipelineRunRow | null> {
        const { rows } = await this.db.query<PipelineRunRow>(
            `UPDATE pipeline_runs SET status='cancelled', error='Cancelled', finished_at=now()
             WHERE id=$1 AND user_id=$2 AND status IN ('running','waiting') RETURNING *`, [runId, userId]);
        return rows[0] ?? null;
    }

    async getRunStatus(runId: number): Promise<string | null> {
        const { rows } = await this.db.query<{ status: string }>(`SELECT status FROM pipeline_runs WHERE id=$1`, [runId]);
        return rows[0]?.status ?? null;
    }

    // Runs paused at an approval, newest first (the approvals inbox).
    async listWaiting(userId: string): Promise<(PipelineRunRow & { pipeline_name: string })[]> {
        const { rows } = await this.db.query(
            `SELECT r.*, p.name AS pipeline_name FROM pipeline_runs r JOIN pipelines p ON p.id = r.pipeline_id
             WHERE r.user_id=$1 AND r.status='waiting' ORDER BY r.started_at DESC LIMIT 50`, [userId]);
        return rows;
    }

    async saveRunSteps(runId: number, steps: PipelineRunStep[]): Promise<void> {
        await this.db.query(`UPDATE pipeline_runs SET steps=$2 WHERE id=$1`, [runId, json(steps)]);
    }

    async finishRun(runId: number, status: "succeeded" | "failed", steps: PipelineRunStep[], output: string | null, error: string | null): Promise<void> {
        await this.db.query(
            `UPDATE pipeline_runs SET status=$2, steps=$3, output=$4, error=$5, finished_at=now() WHERE id=$1`,
            [runId, status, json(steps), output, error]
        );
    }

    async getRun(runId: number, userId: string): Promise<PipelineRunRow | null> {
        const { rows } = await this.db.query<PipelineRunRow>(`SELECT * FROM pipeline_runs WHERE id=$1 AND user_id=$2`, [runId, userId]);
        return rows[0] ?? null;
    }

    async listRuns(pipelineId: string, userId: string, limit = 20): Promise<PipelineRunRow[]> {
        const { rows } = await this.db.query<PipelineRunRow>(
            `SELECT * FROM pipeline_runs WHERE pipeline_id=$1 AND user_id=$2 ORDER BY started_at DESC LIMIT $3`,
            [pipelineId, userId, limit]
        );
        return rows;
    }

    // Runs left "running" by a server restart can never finish.
    async failInterruptedRuns(): Promise<void> {
        await this.db.query(
            // No activity for longer than any one step can take (5 min), so runs
            // still going on another server/worker aren't touched. Workflow runs
            // record their last activity in state.touched_at (they can resume
            // days after they started); paused ('waiting') runs are kept.
            `UPDATE pipeline_runs SET status='failed', error='Interrupted by a server restart', finished_at=now()
             WHERE status='running'
               AND COALESCE((state->>'touched_at')::timestamptz, started_at) < now() - interval '55 minutes'`
        );
    }
}
