import multer from "multer";
import OpenAI, { toFile } from "openai";
import { Chunk, IFileStore, ListResult } from "../interfaces/ifilestore";
import { BaseRouter } from "./base_router";
import { Embedder } from "../database/vector_db/embedding";
import { chunkMarkdown} from "../vector_db/chunking";
import { convertFileToMarkdown } from "../protos/client";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024,
        files: 20,
    },
});

const MAX_CONCURRENT_FILE_OPS = 5;

// Only spreadsheets get mirrored to OpenAI's Files API for code interpreter —
// everything else (pdf, docx, images, txt, ...) keeps going through the
// existing S3 + markdown-conversion + RAG indexing path unchanged. Code
// interpreter's actual value-add is running pandas/numpy over tabular data;
// there's no reason to also push every PDF and image through a second
// upload just to sit unused in an OpenAI container.
const SPREADSHEET_EXTENSIONS = new Set(["csv", "xls", "xlsx"]);

function isSpreadsheetFile(filename: string): boolean {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    return SPREADSHEET_EXTENSIONS.has(ext);
}

// Lazy/optional — if OPENAI_API_KEY isn't set, spreadsheet-to-code-interpreter
// mirroring is silently skipped (see uploadToOpenAI's catch) rather than
// breaking uploads entirely.
const openaiClient = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

type UploadOutcome =
    | { name: string; status: "uploaded"; url: string; openaiFileId?: string }
    | { name: string; status: "failed"; error: string };

export class StorageRoutes extends BaseRouter<IFileStore> {
    constructor(storage: IFileStore, private embedder: Embedder) {
        super("/storage", storage);
    }

    registerRouter(): void {
        this.router.get("/list_files", this.asyncHandler(async (req, res, next) => {
            try {
                const continuationToken = req.query.continuationToken as string | undefined;
                const search = (req.query.search as string | undefined)?.trim();
                const prefix = `${req.user?.sub}/`;

                // S3's ListObjectsV2 only supports a `Prefix` match (from the
                // start of the key), not an arbitrary substring search, so a
                // real search has to walk pages server-side and filter by
                // filename itself — see searchFiles(). This intentionally
                // returns a flat match list with no continuationToken rather
                // than trying to paginate search results the same way a plain
                // listing is paginated.
                if (search) {
                    const matches = await this.searchFiles(prefix, search);
                    return res.status(200).json({ files: matches, continuationToken: undefined });
                }

                const result = await this.service.list(prefix, continuationToken, { includeUrls: true });
                // IFileStore.list() returns { folders, files, nextToken } (see
                // ListResult) — the frontend's ListFilesResponse type and all of
                // storage.tsx's pager logic read `continuationToken`, a field
                // that never actually existed on this response. That mismatch
                // meant `hasNextPage` was always false after page 1, so "Next"
                // stayed disabled forever regardless of how many files existed.
                return res.status(200).json({
                    files: result.files,
                    continuationToken: result.nextToken,
                });
            } catch (error) {
                next(error);
            }
        }));

        this.router.delete("/delete", this.asyncHandler(async (req, res, next) => {
            try {
                console.log(req.body.keys);
                const keys = req.body.keys;
                if (!Array.isArray(keys) || keys.length < 1 || !keys.every(key => typeof key === 'string')) {
                    return res.status(400).json({ message: "keys must be a non-empty array of strings" });
                }
                await this.service.delete(keys);
                try {
                    await this.embedder.deleteBySourceFiles(keys);
                    return res.status(201).json({"message":"Deleted Successfully"});
                } catch (cleanupError) {
                    console.error(`[delete] failed to clean up vectors for keys:`, keys, cleanupError);
                    next(cleanupError);
                }
            } catch (e) {

            }




        }))

        this.router.post(
            "/upload",
            upload.array("files"),
            this.asyncHandler(async (req, res, next) => {
                try {
                    const prefix = `${req.user?.sub}/`;
                    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
                    if (!files.length) {
                        throw new Error("no files provided");
                    }

                    const outcomes = await this.runWithConcurrency(
                        files,
                        MAX_CONCURRENT_FILE_OPS,
                        (file) => this.uploadAndIndex(file, prefix)
                    );
                    const succeeded = outcomes.filter((o) => o.status === "uploaded").length;
                    const failed = outcomes.filter((o) => o.status === "failed");

                    return res.status(failed.length > 0 ? 207 : 200).json({
                        uploaded: succeeded,
                        failed: failed.length,
                        results: outcomes,
                    });
                } catch (error) {
                    next(error);
                }
            })
        );
    }

    private async uploadAndIndex(file: Express.Multer.File, prefix: string): Promise<UploadOutcome> {
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
            const uploaded = await this.service.uploadAndGetUrls(filesToUpload, prefix);
            const originalFileResult = uploaded.find((u) => u.originalname === file.originalname);

            let openaiFileId: string | undefined;
            if (isSpreadsheetFile(file.originalname)) {
                openaiFileId = await this.uploadToOpenAI(file);
            }

            return {
                name: file.originalname,
                status: "uploaded",
                url: originalFileResult?.url ?? "",
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
    private async uploadToOpenAI(file: Express.Multer.File): Promise<string | undefined> {
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

    // Server-side substring search over a user's files. S3 has no native
    // "contains" query, so this walks pages of the existing list() method —
    // exactly what the plain listing already uses — filtering each page by
    // filename as it goes, capped so one search can't turn into an unbounded
    // scan of a huge bucket.
    private readonly SEARCH_MAX_PAGES = 20;   // ~20,000 S3 keys scanned, worst case
    private readonly SEARCH_MAX_RESULTS = 200;

    private async searchFiles(prefix: string, search: string): Promise<ListResult["files"]> {
        const needle = search.toLowerCase();
        const matches: ListResult["files"] = [];
        let token: string | undefined;
        let pages = 0;

        do {
            const page = await this.service.list(prefix, token, { includeUrls: true });
            for (const file of page.files) {
                const displayName = (file.name ?? file.key).toLowerCase();
                if (displayName.includes(needle)) {
                    matches.push(file);
                    if (matches.length >= this.SEARCH_MAX_RESULTS) return matches;
                }
            }
            token = page.nextToken;
            pages += 1;
        } while (token && pages < this.SEARCH_MAX_PAGES);

        return matches;
    }

    private async runWithConcurrency<T, R>(
        items: T[],
        limit: number,
        fn: (item: T) => Promise<R>
    ): Promise<R[]> {
        const results: R[] = new Array(items.length);
        let cursor = 0;
        const worker = async (): Promise<void> => {
            while (true) {
                const index = cursor++;
                if (index >= items.length) return;
                results[index] = await fn(items[index]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
        return results;
    }
}