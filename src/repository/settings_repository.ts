import { IDatabaseAdapter } from "../database/idatabaseadapter";

// Server-wide settings (one JSON value per key) that the owner edits in the
// web app instead of .env.
export class SettingsRepository {
    constructor(private db: IDatabaseAdapter) {}

    async get<T>(key: string): Promise<{ value: T; updated_at: Date; updated_by: string | null } | null> {
        const { rows } = await this.db.query<{ value: T; updated_at: Date; updated_by: string | null }>(
            `SELECT value, updated_at, updated_by FROM app_settings WHERE key = $1`, [key]);
        return rows[0] ?? null;
    }

    async set<T>(key: string, value: T, updatedBy: string | null): Promise<void> {
        await this.db.query(
            `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
            [key, JSON.stringify(value), updatedBy]
        );
    }

    // Writes the value only if the key doesn't exist yet (first-boot seeding;
    // safe when several instances start at once).
    async setIfMissing<T>(key: string, value: T): Promise<void> {
        await this.db.query(
            `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, 'env') ON CONFLICT (key) DO NOTHING`,
            [key, JSON.stringify(value)]
        );
    }
}
