import { AsyncQueue, FileQueue } from "./async_queue";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import { Chunk } from "../interfaces/ifilestore";
import fs from "fs/promises";
import path from "path";
export interface ReadError {
    filePath: string;
    error: unknown;
}

export type ProgressCallback = (done: number, total: number) => void;
export interface LocalMdReaderOptions {
    workerCount?: number;
    queueMaxSize?: number;
    readTimeoutMs?: number;
    onProgress?: ProgressCallback;
    signal?: AbortSignal;
}

export class MDFileParser {
    private readonly dirPath: string;
    private readonly workerCount: number;
    private readonly queueMaxSize: number;
    private readonly readTimeoutMs: number;
    private readonly onProgress?: ProgressCallback;
    private readonly signal?: AbortSignal;
    private _errors: ReadError[] = [];
    constructor(dirPath: string, options: LocalMdReaderOptions = {}) {
        this.dirPath = dirPath;
        this.workerCount = options.workerCount ?? 4;
        this.queueMaxSize = options.queueMaxSize ?? 500;
        this.readTimeoutMs = options.readTimeoutMs ?? 10_000;
        this.onProgress = options.onProgress;
        this.signal = options.signal;
    }

    private async *streamChunks(mdFiles: string[]): AsyncGenerator<Chunk> {
        const queue = new AsyncQueue<Chunk>(this.queueMaxSize);
        const fileQueue = new FileQueue(mdFiles);
        let filesProcessed = 0;

        const onFileDone = () => {
            filesProcessed++;
            this.onProgress?.(filesProcessed, fileQueue.total);
        };

        const allDone = Promise.all(
            Array.from({ length: this.workerCount }, () =>
                this.worker(fileQueue, queue, onFileDone)
            )
        ).then(() => queue.close());

        while (true) {
            if (this.signal?.aborted) {
                queue.close();
                throw new Error("readAll() cancelled via AbortSignal");
            }

            const chunk = await queue.deque();
            if (chunk === null) break;
            yield chunk;
        }

        await allDone;
    }

    private async worker(
        fileQueue: FileQueue<string>,
        queue: AsyncQueue<Chunk>,
        onFileDone: () => void
    ): Promise<void> {
        let nextRead = this.startNextRead(fileQueue);

        while (nextRead !== null) {
            if (this.signal?.aborted || queue.closed) break;

            const { filePath, contentPromise } = nextRead;
            nextRead = this.startNextRead(fileQueue);

            try {
                const chunkCount = await this.parseAndPush(
                    filePath,
                    contentPromise,
                    queue
                );
                console.log(
                    `[worker] "${path.basename(filePath)}" → ${chunkCount} chunks`
                );
            } catch (err) {
                this._errors.push({ filePath, error: err });
                console.error(`[worker] failed on "${filePath}":`, err);
            } finally {
                onFileDone();
            }
        }
    }

    private startNextRead(
        fileQueue: FileQueue<string>
    ): { filePath: string; contentPromise: Promise<string> } | null {
        const filePath = fileQueue.next();
        if (!filePath) return null;
        return {
            filePath,
            contentPromise: this.readWithTimeout(filePath),
        };
    }

    async parseAndPush(filePath: string, contentPromise: Promise<string>, queue: AsyncQueue<Chunk>): Promise<number> {
        const content = await contentPromise;

        const tree = unified()
            .use(remarkParse)
            .use(remarkGfm)
            .parse(content);

        let chunkCount = 0;

        for (const chunk of this.buildChunks(tree, filePath)) {
            if (this.signal?.aborted || queue.closed) break;
            await queue.enqueue(chunk);   // may park if queue is full (backpressure)
            chunkCount++;
        }

        return chunkCount;
    }
    private readWithTimeout(filePath: string): Promise<string> {
        const readPromise = fs.readFile(filePath, "utf-8");

        const timeoutPromise = new Promise<never>((_, reject) => {
            const id = setTimeout(
                () => reject(new Error(
                    `Read timeout after ${this.readTimeoutMs}ms: "${filePath}"`
                )),
                this.readTimeoutMs
            );
            // If the read finishes first, clear the timer so Node can exit cleanly
            readPromise.then(() => clearTimeout(id), () => clearTimeout(id));
        });

        return Promise.race([readPromise, timeoutPromise]);
    }


    private *buildChunks(tree: any, sourceFile: string): Generator<Chunk> {
        let current: Chunk = this.emptyChunk(sourceFile);

        for (const node of tree.children) {
            switch (node.type) {
                case "heading": {
                    const flushed = this.flush(current);
                    if (flushed) yield flushed;
                    current = {
                        ...this.emptyChunk(sourceFile),
                        heading: this.extractNode(node),
                        level: node.depth,
                    };
                    break;
                }

                case "paragraph":
                    current.content += this.extractNode(node) + "\n";
                    break;

                case "code":
                    current.codeBlocks.push({
                        lang: node.lang || "",
                        value: node.value,
                    });
                    break;

                case "list":
                    current.content += this.extractList(node) + "\n";
                    break;

                case "table": {
                    const parsed = this.extractTable(node);
                    current.tables.push(parsed);
                    const headerLine = parsed.headers.join(" | ");
                    const rowLines = parsed.rows.map(r => r.join(" | ")).join("\n");
                    current.content += `Table: ${headerLine}\n${rowLines}\n`;
                    break;
                }

                case "blockquote": {
                    const quoteText = node.children
                        .map((c: any) => this.extractNode(c))
                        .join(" ");
                    current.content += `> ${quoteText}\n`;
                    break;
                }

                case "html":
                    current.content += node.value.replace(/<[^>]+>/g, "").trim() + "\n";
                    break;

                case "thematicBreak": {
                    const flushed = this.flush(current);
                    if (flushed) yield flushed;
                    current = this.emptyChunk(sourceFile);
                    break;
                }

                case "definition":
                case "footnoteDefinition":
                case "yaml":
                    break;

                default:
                    console.warn(`[buildChunks] unhandled node type: "${node.type}"`);
            }
        }

        const last = this.flush(current);
        if (last) yield last;
    }

    private emptyChunk(sourceFile: string): Chunk {
        return {
            heading: "",
            level: 0,
            content: "",
            codeBlocks: [],
            tables: [],
            sourceFile,
        };
    }

    private flush(current: Chunk): Chunk | null {
        if (
            current.content.trim() ||
            current.codeBlocks.length > 0 ||
            current.tables.length > 0
        ) {
            return { ...current };
        }
        return null;
    }

    private extractNode(node: any): string {
        if (node.type === "text" || node.type === "inlineCode") return node.value;
        if (["strong", "emphasis", "delete"].includes(node.type)) {
            return node.children?.map((c: any) => this.extractNode(c)).join("") ?? "";
        }
        if (node.type === "link") {
            const text = node.children?.map((c: any) => this.extractNode(c)).join("") ?? "";
            return node.url ? `${text} (${node.url})` : text;
        }
        if (!node.children) return "";
        return node.children.map((c: any) => this.extractNode(c)).join("");
    }

    private extractTable(node: any): { headers: string[]; rows: string[][] } {
        const [headerRow, ...dataRows] = node.children;
        const headers = headerRow.children.map((cell: any) =>
            cell.children?.map((c: any) => this.extractNode(c)).join("").trim() ?? ""
        );
        const rows = dataRows.map((row: any) =>
            row.children.map((cell: any) =>
                cell.children?.map((c: any) => this.extractNode(c)).join("").trim() ?? ""
            )
        );
        return { headers, rows };
    }

    private extractList(node: any, depth = 0): string {
        let result = "";
        for (const item of node.children) {
            const indent = "  ".repeat(depth);
            for (const child of item.children) {
                if (child.type === "paragraph") {
                    result += `${indent}- ${this.extractNode(child)}\n`;
                } else if (child.type === "list") {
                    result += this.extractList(child, depth + 1);
                }
            }
        }
        return result;
    }

}