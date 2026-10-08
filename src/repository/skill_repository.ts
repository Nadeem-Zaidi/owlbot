import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type SkillRow = {
    id: string;
    user_id: string;
    name: string;
    description: string;
    content: string;
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
};

export type SkillInput = Pick<SkillRow, "name" | "description" | "content" | "enabled">;

// A user's skills. Every query is scoped to the owner.
export class SkillRepository {
    constructor(private db: IDatabaseAdapter) {}

    // Without content (the library list and each request's skill index).
    async list(userId: string, enabledOnly = false): Promise<Omit<SkillRow, "content">[]> {
        const { rows } = await this.db.query(
            `SELECT id, user_id, name, description, enabled, created_at, updated_at, char_length(content) AS chars
             FROM skills WHERE user_id = $1 ${enabledOnly ? "AND enabled" : ""} ORDER BY name`,
            [userId]
        );
        return rows;
    }

    async get(userId: string, id: string): Promise<SkillRow | null> {
        const { rows } = await this.db.query<SkillRow>(`SELECT * FROM skills WHERE user_id = $1 AND id = $2`, [userId, id]);
        return rows[0] ?? null;
    }

    async getByName(userId: string, name: string): Promise<SkillRow | null> {
        const { rows } = await this.db.query<SkillRow>(`SELECT * FROM skills WHERE user_id = $1 AND name = $2`, [userId, name]);
        return rows[0] ?? null;
    }

    async count(userId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM skills WHERE user_id = $1`, [userId]);
        return rows[0]?.n ?? 0;
    }

    async create(userId: string, s: SkillInput): Promise<SkillRow> {
        const { rows } = await this.db.query<SkillRow>(
            `INSERT INTO skills (id, user_id, name, description, content, enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [randomUUID(), userId, s.name, s.description, s.content, s.enabled]
        );
        return rows[0];
    }

    async update(userId: string, id: string, s: SkillInput): Promise<SkillRow | null> {
        const { rows } = await this.db.query<SkillRow>(
            `UPDATE skills SET name=$3, description=$4, content=$5, enabled=$6, updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *`,
            [userId, id, s.name, s.description, s.content, s.enabled]
        );
        return rows[0] ?? null;
    }

    async delete(userId: string, id: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM skills WHERE user_id = $1 AND id = $2`, [userId, id]);
        return r.rowCount > 0;
    }
}
