import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";

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
    status: "running" | "succeeded" | "failed";
    input: string;
    steps: PipelineRunStep[];
    output: string | null;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
};

export type PipelineInput = Pick<PipelineRow, "name" | "description" | "steps">;

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
            `INSERT INTO pipelines (id, user_id, name, description, steps) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [randomUUID(), userId, p.name, p.description, json(p.steps)]
        );
        return rows[0];
    }

    async update(id: string, userId: string, p: PipelineInput): Promise<PipelineRow | null> {
        const { rows } = await this.db.query<PipelineRow>(
            `UPDATE pipelines SET name=$3, description=$4, steps=$5, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
            [id, userId, p.name, p.description, json(p.steps)]
        );
        return rows[0] ?? null;
    }

    async remove(id: string, userId: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM pipelines WHERE id=$1 AND user_id=$2`, [id, userId]);
        return r.rowCount > 0;
    }

    async startRun(pipelineId: string, userId: string, input: string, steps: PipelineRunStep[]): Promise<PipelineRunRow> {
        const { rows } = await this.db.query<PipelineRunRow>(
            `INSERT INTO pipeline_runs (pipeline_id, user_id, status, input, steps) VALUES ($1,$2,'running',$3,$4) RETURNING *`,
            [pipelineId, userId, input, json(steps)]
        );
        return rows[0];
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
            // Older than the longest possible run (10 steps × 5 min), so runs still
            // going on another server/worker aren't touched.
            `UPDATE pipeline_runs SET status='failed', error='Interrupted by a server restart', finished_at=now()
             WHERE status='running' AND started_at < now() - interval '55 minutes'`
        );
    }
}
