import { randomUUID } from "node:crypto";
import { IFileStore } from "../../interfaces/ifilestore";
import { buildDocument, DocumentSpecError, previewDocument } from "../../protos/client";
import { DocumentRepository, GeneratedFileRow } from "../../repository/document_repository";

export const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_LOGO_BYTES = 500_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Bump when the Python preview output changes, so cached previews are rebuilt.
const PREVIEW_FILE = ".preview-v1.json";
const FONTS = ["Calibri", "Aptos", "Arial", "Segoe UI", "Verdana", "Cambria", "Georgia", "Times New Roman"];

export class DocumentError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

export type DocumentStyle = { company: string; color: string; font: string; footer: string; currency: string; hasLogo: boolean };

export type GeneratedFileDto = Pick<GeneratedFileRow, "id" | "kind" | "filename" | "size"> & { created_at: Date };

const dto = (f: GeneratedFileRow): GeneratedFileDto => ({ id: f.id, kind: f.kind, filename: f.filename, size: f.size, created_at: f.created_at });

// "Q3 report: final/v2" → "Q3 report final v2.docx"
export function safeFileName(raw: unknown, fallback: string, ext: "docx" | "xlsx"): string {
    const base = String(raw ?? "").replace(/\.(docx?|xlsx?|csv|pdf)$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${base || fallback}.${ext}`;
}

// Word and Excel files made by the assistant. The Python service builds
// them (DocumentBuilder); they're stored in S3 under generated/<user>/ —
// outside the knowledge base, so they don't show up as documents there.
export class DocumentService {
    constructor(private repo: DocumentRepository, private storage: IFileStore) {}

    async createWord(userId: string, sessionId: string | null, args: any): Promise<GeneratedFileDto> {
        const title = String(args?.title ?? "").trim().slice(0, 200);
        const spec: Record<string, unknown> = { title, subtitle: String(args?.subtitle ?? "").slice(0, 300), markdown: String(args?.markdown ?? "") };
        // Layout options the assistant picks per document (the Python builder validates them).
        for (const k of ["branding", "show_title", "show_date", "cover_page", "toc", "page_numbers"]) {
            if (typeof args?.[k] === "boolean") spec[k] = args[k];
        }
        if (args?.orientation === "landscape" || args?.orientation === "portrait") spec.orientation = args.orientation;
        if (typeof args?.page_size === "string" && /^(a4|letter)$/i.test(args.page_size)) spec.page_size = args.page_size;
        return this.create(userId, sessionId, "word", safeFileName(args?.filename || title, "Document", "docx"), spec);
    }

    async createExcel(userId: string, sessionId: string | null, args: any): Promise<GeneratedFileDto> {
        const spec = { title: String(args?.title ?? "").slice(0, 200), sheets: args?.sheets, style: args?.style === "plain" ? "plain" : "branded" };
        return this.create(userId, sessionId, "excel", safeFileName(args?.filename || args?.title, "Spreadsheet", "xlsx"), spec);
    }

    private async create(userId: string, sessionId: string | null, kind: "word" | "excel", filename: string, spec: unknown) {
        const style = await this.repo.getStyle(userId);
        const content = await buildDocument(kind, spec, style ? { company: style.company, color: style.color, font: style.font, footer: style.footer, currency: style.currency } : {}, kind === "word" ? style?.logo : null)
            .catch((err) => { throw err instanceof DocumentSpecError ? new DocumentError(err.message) : err; });
        if (content.length > MAX_FILE_BYTES) throw new DocumentError("The file is too large — split it into smaller documents.");
        const id = randomUUID();
        const mime = kind === "word" ? WORD_MIME : EXCEL_MIME;
        const prefix = `generated/${userId}/${id}/`;
        await this.storage.upload([{ buffer: content, originalname: filename, mimetype: mime }], prefix);
        return dto(await this.repo.addFile({ id, user_id: userId, session_id: sessionId, kind, filename, mime, s3_key: prefix + filename, size: content.length }));
    }

    // The file's bytes (download route, WhatsApp/Telegram delivery).
    async load(userId: string, id: string): Promise<{ buffer: Buffer; filename: string; mime: string }> {
        const f = await this.row(userId, id);
        return { buffer: await this.read(f.s3_key), filename: f.filename, mime: f.mime };
    }

    // The in-app viewer's preview (JSON). Files never change, so it's built
    // once by the Python service and kept next to the file.
    async preview(userId: string, id: string): Promise<Buffer> {
        const f = await this.row(userId, id);
        const prefix = f.s3_key.slice(0, f.s3_key.lastIndexOf("/") + 1);
        try {
            return await this.read(prefix + PREVIEW_FILE);
        } catch { /* not built yet */ }
        const json = await previewDocument(f.kind, await this.read(f.s3_key))
            .catch((err) => { throw err instanceof DocumentSpecError ? new DocumentError(err.message, 422) : err; });
        await this.storage.upload([{ buffer: json, originalname: PREVIEW_FILE, mimetype: "application/json" }], prefix)
            .catch((err) => console.warn("[documents] couldn't cache the preview:", err instanceof Error ? err.message : err));
        return json;
    }

    private async row(userId: string, id: string): Promise<GeneratedFileRow> {
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DocumentError("File not found", 404);
        const f = await this.repo.getFile(userId, id);
        if (!f) throw new DocumentError("File not found", 404);
        return f;
    }

    private async read(key: string): Promise<Buffer> {
        const parts: Buffer[] = [];
        for await (const part of await this.storage.readStream(key)) parts.push(Buffer.from(part));
        return Buffer.concat(parts);
    }

    // ── document style ──
    async style(userId: string): Promise<DocumentStyle> {
        const s = await this.repo.getStyle(userId);
        return { company: s?.company ?? "", color: s?.color ?? "#2A74A8", font: s?.font ?? "Calibri", footer: s?.footer ?? "", currency: s?.currency ?? "₹", hasLogo: !!s?.logo };
    }

    async saveStyle(userId: string, b: any): Promise<DocumentStyle> {
        const current = await this.style(userId);
        const text = (v: unknown, max: number, field: string, fallback: string) => {
            if (v === undefined) return fallback;
            const s = String(v ?? "").trim();
            if (s.length > max) throw new DocumentError(`${field} must be at most ${max} characters`);
            return s;
        };
        const color = text(b?.color, 7, "Colour", current.color);
        if (!/^#[0-9a-f]{6}$/i.test(color)) throw new DocumentError("Colour must look like #2A74A8");
        const font = text(b?.font, 40, "Font", current.font);
        if (!FONTS.includes(font)) throw new DocumentError(`Font must be one of: ${FONTS.join(", ")}`);
        await this.repo.saveStyle(userId, {
            company: text(b?.company, 120, "Company name", current.company),
            color,
            font,
            footer: text(b?.footer, 200, "Footer", current.footer),
            currency: text(b?.currency, 3, "Currency symbol", current.currency) || "₹",
        });
        return this.style(userId);
    }

    // PNG or JPEG, as base64 (data: URL or plain), up to 500 KB.
    async saveLogo(userId: string, data: unknown): Promise<DocumentStyle> {
        const raw = String(data ?? "").replace(/^data:image\/[a-z]+;base64,/i, "");
        const buf = Buffer.from(raw, "base64");
        if (!buf.length) throw new DocumentError("Send the logo as a PNG or JPEG image");
        if (buf.length > MAX_LOGO_BYTES) throw new DocumentError("The logo must be under 500 KB");
        const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
        if (!png && !jpeg) throw new DocumentError("The logo must be a PNG or JPEG image");
        await this.repo.saveLogo(userId, buf, png ? "image/png" : "image/jpeg");
        return this.style(userId);
    }

    async removeLogo(userId: string): Promise<DocumentStyle> {
        await this.repo.saveLogo(userId, null, null);
        return this.style(userId);
    }

    async logo(userId: string): Promise<{ buffer: Buffer; mime: string } | null> {
        const s = await this.repo.getStyle(userId);
        return s?.logo ? { buffer: s.logo, mime: s.logo_mime ?? "image/png" } : null;
    }
}

export const FONT_CHOICES = FONTS;
