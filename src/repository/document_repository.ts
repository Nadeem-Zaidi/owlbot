import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type GeneratedFileRow = {
    id: string;
    user_id: string;
    session_id: string | null;
    kind: "word" | "excel";
    filename: string;
    mime: string;
    s3_key: string;
    size: number;
    created_at: Date;
};

export type DocumentStyleRow = {
    user_id: string;
    company: string;
    color: string;
    font: string;
    footer: string;
    currency: string;
    logo: Buffer | null;
    logo_mime: string | null;
    updated_at: Date;
};

// Generated files and document styles; every query is scoped to the user.
export class DocumentRepository {
    constructor(private db: IDatabaseAdapter) {}

    async addFile(f: Omit<GeneratedFileRow, "created_at">): Promise<GeneratedFileRow> {
        const { rows } = await this.db.query<GeneratedFileRow>(
            `INSERT INTO generated_files (id, user_id, session_id, kind, filename, mime, s3_key, size)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [f.id, f.user_id, f.session_id, f.kind, f.filename, f.mime, f.s3_key, f.size]
        );
        return rows[0];
    }

    async getFile(userId: string, id: string): Promise<GeneratedFileRow | null> {
        const { rows } = await this.db.query<GeneratedFileRow>(`SELECT * FROM generated_files WHERE user_id = $1 AND id = $2`, [userId, id]);
        return rows[0] ?? null;
    }

    async getStyle(userId: string): Promise<DocumentStyleRow | null> {
        const { rows } = await this.db.query<DocumentStyleRow>(`SELECT * FROM document_styles WHERE user_id = $1`, [userId]);
        return rows[0] ?? null;
    }

    async saveStyle(userId: string, s: Pick<DocumentStyleRow, "company" | "color" | "font" | "footer" | "currency">): Promise<void> {
        await this.db.query(
            `INSERT INTO document_styles (user_id, company, color, font, footer, currency, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,now())
             ON CONFLICT (user_id) DO UPDATE SET company=$2, color=$3, font=$4, footer=$5, currency=$6, updated_at=now()`,
            [userId, s.company, s.color, s.font, s.footer, s.currency]
        );
    }

    async saveLogo(userId: string, logo: Buffer | null, mime: string | null): Promise<void> {
        await this.db.query(
            `INSERT INTO document_styles (user_id, logo, logo_mime, updated_at) VALUES ($1,$2,$3,now())
             ON CONFLICT (user_id) DO UPDATE SET logo=$2, logo_mime=$3, updated_at=now()`,
            [userId, logo, mime]
        );
    }
}
