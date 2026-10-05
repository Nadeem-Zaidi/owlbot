import multer from "multer";
import { IFileStore, ListResult } from "../interfaces/ifilestore";
import { BaseRouter } from "./base_router";
import { Embedder } from "../database/vector_db/embedding";
import { KnowledgeBase } from "../service/knowledge_base";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024,
        files: 20,
    },
});

const MAX_CONCURRENT_FILE_OPS = 5;

export class StorageRoutes extends BaseRouter<IFileStore> {
    constructor(storage: IFileStore, private embedder: Embedder, private kb: KnowledgeBase) {
        super("/storage", storage);
    }

    registerRouter(): void {
        // Documents indexed in the user's knowledge base (one row per file).
        this.router.get("/documents", this.asyncHandler(async (req, res) => {
            const documents = await this.kb.listDocuments(req.user!.sub);
            return res.status(200).json({ documents });
        }));

        // Full text of one indexed document, for "explain this document".
        this.router.get("/document_content", this.asyncHandler(async (req, res) => {
            const raw = typeof req.query.key === "string" ? req.query.key : "";
            let doc;
            try {
                doc = await this.kb.readDocument(req.user!.sub, raw);
            } catch (err) {
                return res.status(400).json({ message: err instanceof Error ? err.message : "Invalid document key" });
            }
            if (!doc) {
                const name = raw.split("/").pop() || raw;
                return res.status(404).json({ message: `"${name}" isn't in your knowledge base anymore.` });
            }
            return res.status(200).json(doc);
        }));

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
                        (file) => this.kb.ingest(file, prefix)
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