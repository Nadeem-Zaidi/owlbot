import OpenAI, { toFile } from "openai";
import { Chunk, IFileStore } from "../interfaces/ifilestore";
import { Embedder } from "../database/vector_db/embedding";
import { chunkMarkdown } from "../vector_db/chunking";
import { convertFileToMarkdown } from "../protos/client";
import { IVectorDb } from "../interfaces/vectordb/ivector";

// Cap on how much of a document the "explain this document" flow sends to
// the model. The text is stored with the chat and re-sent on every later
// turn, so an uncapped 300-page PDF would make each reply slow and costly.
// Results flag `truncated` so callers can say so instead of hiding it.
const DOC_MAX_CHARS = Number(process.env.DOC_EXPLAIN_MAX_CHARS ?? 120_000);

// Only spreadsheets get mirrored to OpenAI's Files API for code interpreter —
// everything else (pdf, docx, images, txt, ...) goes through S3 + markdown
// conversion + RAG indexing. Code interpreter's value-add is running
// pandas/numpy over tabular data; there's no reason to push every PDF there.
const SPREADSHEET_EXTENSIONS = new Set(["csv", "xls", "xlsx"]);

function isSpreadsheetFile(filename: string): boolean {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    return SPREADSHEET_EXTENSIONS.has(ext);
}

// Optional — without OPENAI_API_KEY, spreadsheet mirroring is skipped.
const openaiClient = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

export type IngestFile = { buffer: Buffer; originalname: string; mimetype: string };

export type UploadOutcome =
    | { name: string; status: "uploaded"; url: string; openaiFileId?: string; sections?: number }
    | { name: string; status: "failed"; error: string };

export type KnowledgeDocument = { key: string; name: string; chunks: number; updatedAt: Date };

export type DocumentText = { key: string; name: string; content: string; truncated: boolean; totalChars: number };

// The user's knowledge base — listing, reading and adding documents. Shared
// by the web routes (storage_routes.ts) and the WhatsApp bridge so both
// index and read documents exactly the same way.
export class KnowledgeBase {
    constructor(private storage: IFileStore, private embedder: Embedder, private vectorDb?: IVectorDb) {}

    async listDocuments(userId: string): Promise<KnowledgeDocument[]> {
        if (!this.vectorDb?.listSourceFiles) return [];
        const rows = await this.vectorDb.listSourceFiles(`${userId}/`);
        return rows.map((r) => ({
            key: r.source_file,
            name: r.source_file.split("/").pop() || r.source_file,
            chunks: r.chunks,
            updatedAt: r.updated_at,
        }));
    }

    // `rawKey` is a RAG source_file (S3 key) or a bare filename; either way
    // it's resolved inside the user's own folder. Null if it isn't there.
    async readDocument(userId: string, rawKey: string): Promise<DocumentText | null> {
        const raw = rawKey.trim();
        if (!raw || raw.includes("..")) throw new Error("A valid document key is required");
        const prefix = `${userId}/`;
        const key = raw.startsWith(prefix) ? raw : `${prefix}${raw.replace(/^\/+/, "")}`;
        const name = key.split("/").pop() || key;

        const content = await this.readDocumentText(key);
        if (!content) return null;
        const truncated = content.length > DOC_MAX_CHARS;
        return {
            key,
            name,
            content: truncated ? content.slice(0, DOC_MAX_CHARS) : content,
            truncated,
            totalChars: content.length,
        };
    }

    async ingest(file: IngestFile, prefix: string): Promise<UploadOutcome> {
        return this.uploadAndIndex(file, prefix);
    }

    private async uploadAndIndex(file: IngestFile, prefix: string): Promise<UploadOutcome> {
        const key = `${prefix}${file.originalname}`;

        let markdown: string | null = null;
        let markdownFilename: string | null = null;

        try {
            const result = await convertFileToMarkdown(file.originalname, file.buffer);
            markdown = result.markdown;
            markdownFilename = result.filename;
        } catch (error) {
            console.error(`[upload] markdown conversion failed for "${file.originalname}":`, error);
            // fall through — original file still gets uploaded, just skipped for indexing
        }

        let chunks: Chunk[] = [];
        if (markdown) {
            chunks = chunkMarkdown(markdown, key);
        }

        let vectorIds: string[] = [];
        if (chunks.length > 0) {
            try {
                vectorIds = await this.embedder.embedAndStore(chunks);
            } catch (error) {
                return { name: file.originalname, status: "failed", error: `Indexing failed: ${error}` };
            }
        }

        const filesToUpload: { buffer: Buffer; originalname: string; mimetype: string }[] = [
            { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype },
        ];

        if (markdown && markdownFilename) {
            filesToUpload.push({
                buffer: Buffer.from(markdown, "utf-8"),
                originalname: markdownFilename,
                mimetype: "text/markdown",
            });
        }

        try {
            const uploaded = await this.storage.uploadAndGetUrls(filesToUpload, prefix);
            const originalFileResult = uploaded.find((u) => u.originalname === file.originalname);

            // Re-uploading a file replaces its index: drop chunks from the old
            // version that the new one no longer has (unchanged ones keep their id).
            await this.dropStaleChunks(key, vectorIds);

            let openaiFileId: string | undefined;
            if (isSpreadsheetFile(file.originalname)) {
                openaiFileId = await this.uploadToOpenAI(file);
            }

            return {
                name: file.originalname,
                status: "uploaded",
                url: originalFileResult?.url ?? "",
                sections: chunks.length,
                ...(openaiFileId ? { openaiFileId } : {}),
            };
        } catch (error) {
            if (vectorIds.length > 0) {
                try {
                    await this.embedder.deleteVectors(vectorIds);
                } catch (cleanupError) {
                    console.error(`[upload] failed to roll back vectors for "${key}":`, cleanupError);
                }
            }
            return { name: file.originalname, status: "failed", error: `Upload failed: ${error}` };
        }
    }

    // Mirrors a spreadsheet to OpenAI's Files API so the code interpreter
    // container can later be given its file_id and actually read it —
    // uploading to S3 alone (uploadAndGetUrls above) only produces a link,
    // which the container has no way to fetch. Failure here is deliberately
    // non-fatal: the S3 upload and RAG indexing already succeeded by the
    // time this runs, so a hiccup with OpenAI (missing key, transient
    // network error) should degrade to "code interpreter can't see this
    // file yet" rather than failing the whole upload.
    private async uploadToOpenAI(file: IngestFile): Promise<string | undefined> {
        if (!openaiClient) {
            console.warn(`[upload] OPENAI_API_KEY not set — skipping code-interpreter mirror for "${file.originalname}"`);
            return undefined;
        }
        try {
            const uploadableFile = await toFile(file.buffer, file.originalname, { type: file.mimetype });
            const created = await openaiClient.files.create({
                file: uploadableFile,
                purpose: "assistants",
            });
            return created.id;
        } catch (error) {
            console.error(`[upload] OpenAI Files API mirror failed for "${file.originalname}":`, error);
            return undefined;
        }
    }

    private async dropStaleChunks(key: string, keepIds: string[]): Promise<void> {
        if (!this.vectorDb?.deleteStaleChunks || keepIds.length === 0) return;
        try {
            const removed = await this.vectorDb.deleteStaleChunks(key, keepIds);
            if (removed) console.log(`[upload] removed ${removed} outdated chunks of "${key}"`);
        } catch (error) {
            console.error(`[upload] could not remove outdated chunks of "${key}":`, error);
        }
    }

    // Re-chunks and re-embeds one already-indexed document with the current
    // chunker — used after chunking changes (scripts/reindex_kb.ts). Reads the
    // stored Markdown copy; documents indexed before copies were kept are
    // rebuilt from their existing chunks instead.
    async reindexDocument(key: string): Promise<{ key: string; before: number; after: number; from: "markdown" | "chunks" } | null> {
        if (!this.vectorDb?.getChunksBySourceFile) return null;
        const existing = await this.vectorDb.getChunksBySourceFile(key);
        let markdown = await this.readMarkdownCopy(key);
        const from = markdown ? "markdown" : "chunks";
        if (!markdown) {
            // Stored chunks start with "Section: <heading path>" — turn that
            // back into a heading so the chunker sees the structure again.
            markdown = existing
                .map((c) => c.content.replace(/^Section: (.*)$/m, (_m, h: string) => `## ${h.split(" > ").pop()}`))
                .join("\n\n")
                .trim();
        }
        if (!markdown) return null;
        const chunks = chunkMarkdown(markdown, key);
        if (chunks.length === 0) return null;
        const ids = await this.embedder.embedAndStore(chunks);
        await this.vectorDb.deleteStaleChunks?.(key, ids);
        return { key, before: existing.length, after: chunks.length, from };
    }

    private async readMarkdownCopy(key: string): Promise<string | null> {
        const stem = key.replace(/\.[^./]+$/, "");
        const candidates = key.toLowerCase().endsWith(".md") ? [key] : [`${stem}.md`, `${key}.md`];
        for (const candidate of candidates) {
            try {
                const parts: Buffer[] = [];
                for await (const part of await this.storage.readStream(candidate)) parts.push(Buffer.from(part));
                const text = Buffer.concat(parts).toString("utf-8").trim();
                if (text) return text;
            } catch {
                // not there — try the next candidate
            }
        }
        return null;
    }

    // Prefers the Markdown copy that uploadAndIndex() stores next to the
    // original (that's the exact text that was chunked and embedded), then
    // falls back to stitching the indexed chunks back together.
    private async readDocumentText(key: string): Promise<string | null> {
        const copy = await this.readMarkdownCopy(key);
        if (copy) return copy;

        if (!this.vectorDb?.getChunksBySourceFile) return null;
        const chunks = await this.vectorDb.getChunksBySourceFile(key);
        if (!chunks.length) return null;
        // Stored chunk content already starts with "Section: <heading>".
        return chunks.map((c) => c.content).join("\n\n").trim() || null;
    }
}
