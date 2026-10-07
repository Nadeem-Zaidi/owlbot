import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type ArtifactKind = "html" | "markdown";

export type ArtifactRow = {
    id: string;
    user_id: string;
    session_id: string | null;
    title: string;
    kind: ArtifactKind;
    current_version: number;
    created_at: Date;
    updated_at: Date;
};

export type ArtifactVersionRow = {
    version: number;
    title: string;
    content: string;
    change_summary: string | null;
    created_at: Date;
};

// Documents/reports the assistant creates in a chat. Every edit is a new
// version, so earlier ones stay viewable. All queries are scoped to the owner.
export class ArtifactRepository {
    constructor(private db: IDatabaseAdapter) {}

    async create(userId: string, sessionId: string | null, kind: ArtifactKind, title: string, content: string): Promise<ArtifactRow> {
        return this.db.withTransaction(async () => {
            const id = randomUUID();
            const { rows } = await this.db.query<ArtifactRow>(
                `INSERT INTO artifacts (id, user_id, session_id, title, kind) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [id, userId, sessionId, title, kind]
            );
            await this.db.query(
                `INSERT INTO artifact_versions (artifact_id, version, title, content) VALUES ($1, 1, $2, $3)`,
                [id, title, content]
            );
            return rows[0];
        });
    }

    // Adds a version; returns null if the artifact isn't this user's.
    async addVersion(userId: string, id: string, title: string, content: string, changeSummary: string | null): Promise<ArtifactRow | null> {
        return this.db.withTransaction(async () => {
            const { rows } = await this.db.query<ArtifactRow>(
                `UPDATE artifacts SET current_version = current_version + 1, title = $3, updated_at = now()
                 WHERE id = $1 AND user_id = $2 RETURNING *`,
                [id, userId, title]
            );
            const art = rows[0];
            if (!art) return null;
            await this.db.query(
                `INSERT INTO artifact_versions (artifact_id, version, title, content, change_summary) VALUES ($1, $2, $3, $4, $5)`,
                [id, art.current_version, title, content, changeSummary]
            );
            return art;
        });
    }

    async get(userId: string, id: string): Promise<ArtifactRow | null> {
        const { rows } = await this.db.query<ArtifactRow>(`SELECT * FROM artifacts WHERE id = $1 AND user_id = $2`, [id, userId]);
        return rows[0] ?? null;
    }

    async version(id: string, version: number): Promise<ArtifactVersionRow | null> {
        const { rows } = await this.db.query<ArtifactVersionRow>(
            `SELECT version, title, content, change_summary, created_at FROM artifact_versions WHERE artifact_id = $1 AND version = $2`,
            [id, version]
        );
        return rows[0] ?? null;
    }

    async versions(id: string): Promise<Omit<ArtifactVersionRow, "content">[]> {
        const { rows } = await this.db.query<Omit<ArtifactVersionRow, "content">>(
            `SELECT version, title, change_summary, created_at FROM artifact_versions WHERE artifact_id = $1 ORDER BY version`,
            [id]
        );
        return rows;
    }
}
