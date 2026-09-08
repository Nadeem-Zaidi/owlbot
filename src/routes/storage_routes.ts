import multer from "multer";
import { Chunk, IFileStore } from "../interfaces/ifilestore";
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

type UploadOutcome =
    | { name: string; status: "uploaded"; url: string }
    | { name: string; status: "failed"; error: string };

export class StorageRoutes extends BaseRouter<IFileStore> {
    constructor(storage: IFileStore, private embedder: Embedder) {
        super("/storage", storage);
    }

    registerRouter(): void {
        this.router.get("/list_files", this.asyncHandler(async (req, res, next) => {
            try {
                const continuationToken = req.query.continuationToken as string | undefined;
                const prefix = `${req.user?.sub}/`;
                const result = await this.service.list(prefix, continuationToken, { includeUrls: true });
                return res.status(200).json(result);
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
            return { name: file.originalname, status: "uploaded", url: originalFileResult?.url ?? "" };
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