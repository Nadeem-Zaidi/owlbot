import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type SkillRow = {
    id: string;
    user_id: string;
    name: string;
    description: string;
    content: string;
    enabled: boolean;
    // From a skill folder's front matter / where it was imported from.
    license?: string | null;
    source?: string | null;
    created_at: Date;
    updated_at: Date;
};

export type SkillInput = Pick<SkillRow, "name" | "description" | "content" | "enabled"> & { license?: string | null; source?: string | null };
export type SkillFileRow = { skill_id: string; path: string; kind: "reference" | "script"; content: string; bytes: number; created_at: Date };

// A user's skills. Every query is scoped to the owner.
export class SkillRepository {
    constructor(private db: IDatabaseAdapter) {}

    // Without content (the library list and each request's skill index).
    async list(userId: string, enabledOnly = false): Promise<Omit<SkillRow, "content">[]> {
        const { rows } = await this.db.query(
            `SELECT id, user_id, name, description, enabled, license, source, created_at, updated_at, char_length(content) AS chars,
                    (SELECT count(*)::int FROM skill_files f WHERE f.skill_id = skills.id) AS file_count
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
            `INSERT INTO skills (id, user_id, name, description, content, enabled, license, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [randomUUID(), userId, s.name, s.description, s.content, s.enabled, s.license ?? null, s.source ?? null]
        );
        return rows[0];
    }

    // A skill folder: the skill and its files together, or nothing.
    async createWithFiles(userId: string, s: SkillInput, files: { path: string; kind: "reference" | "script"; content: string; bytes: number }[]): Promise<SkillRow> {
        return this.db.withTransaction(async () => {
            const skill = await this.create(userId, s);
            for (const f of files) {
                await this.db.query(
                    `INSERT INTO skill_files (skill_id, path, kind, content, bytes) VALUES ($1, $2, $3, $4, $5)`,
                    [skill.id, f.path, f.kind, f.content, f.bytes]);
            }
            return skill;
        });
    }

    // ── files (scoped through the owning skill) ──
    async listFiles(userId: string, skillId: string): Promise<Omit<SkillFileRow, "content">[]> {
        const { rows } = await this.db.query(
            `SELECT f.skill_id, f.path, f.kind, f.bytes, f.created_at FROM skill_files f JOIN skills s ON s.id = f.skill_id
             WHERE s.user_id = $1 AND s.id = $2 ORDER BY f.path`, [userId, skillId]);
        return rows;
    }

    async getFile(userId: string, skillId: string, path: string): Promise<SkillFileRow | null> {
        const { rows } = await this.db.query<SkillFileRow>(
            `SELECT f.* FROM skill_files f JOIN skills s ON s.id = f.skill_id WHERE s.user_id = $1 AND s.id = $2 AND f.path = $3`,
            [userId, skillId, path]);
        return rows[0] ?? null;
    }

    async deleteFile(userId: string, skillId: string, path: string): Promise<boolean> {
        const r = await this.db.query(
            `DELETE FROM skill_files f USING skills s WHERE s.id = f.skill_id AND s.user_id = $1 AND s.id = $2 AND f.path = $3`,
            [userId, skillId, path]);
        return r.rowCount > 0;
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
