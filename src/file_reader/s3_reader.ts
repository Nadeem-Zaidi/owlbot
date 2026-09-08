import remarkParse from "remark-parse";
import { unified } from "unified";
import dotenv from "dotenv";
import { ListResult, S3Config, S3File } from "../types/type";
import { AsyncQueue } from "../utils/async_queue";
import remarkGfm from "remark-gfm";
import { Chunk, IFileStore } from "../interfaces/ifilestore";
import { chunkMarkdown } from "../vector_db/chunking";

dotenv.config();

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Max paragraphs / chunks held in the in-process buffer before back-pressure kicks in. */
const TXT_BUFFER_HIGH_WATERMARK = 64;
const MD_QUEUE_HIGH_WATERMARK = 32;

// ─── Tiny O(1) FIFO queue ────────────────────────────────────────────────────
// Array.prototype.shift() is O(n). This uses a head-pointer so every
// enqueue and dequeue is O(1) and no element is ever copied.

class PointerQueue<T> {
    private items: (T | undefined)[] = [];
    private head = 0;

    enqueue(item: T): void {
        this.items.push(item);
    }

    dequeue(): T | undefined {
        if (this.head >= this.items.length) return undefined;
        const item = this.items[this.head];
        this.items[this.head] = undefined; // release reference
        this.head++;
        // Compact once the dead prefix grows large enough to be worth it
        if (this.head > 1024 && this.head > this.items.length >> 1) {
            this.items = this.items.slice(this.head);
            this.head = 0;
        }
        return item;
    }

    get size(): number {
        return this.items.length - this.head;
    }

    get empty(): boolean {
        return this.head >= this.items.length;
    }
}

export class S3Reader {
    private readonly storage: IFileStore;
    private readonly readTimeoutMs: number = 3000;
    private readonly signal?: AbortSignal;

    // `config` is accepted for interface/DI parity with other readers but is
    // not currently used by this class — kept so callers don't need changing.
    constructor(storage: IFileStore, readTimeoutMs: number, signal?: AbortSignal) {
        this.storage = storage;
        this.readTimeoutMs = readTimeoutMs;
        this.signal = signal;
    }

    async *read_txt_files(prefix: string, workerCount: number): AsyncGenerator<{ file: string; paragraph: string }> {
        const fileQueue = new PointerQueue<S3File>();
        const outBuffer = new PointerQueue<{ file: string; paragraph: string }>();

        let listDone = false;
        let workersDone = false;
        let workerError: unknown = null;
        let buffered = 0;

        let consumerWaker: (() => void) | null = null;
        let producerWakers: (() => void)[] = [];

        const wakeConsumer = () => { consumerWaker?.(); consumerWaker = null; };
        const wakeProducers = () => { producerWakers.forEach(fn => fn()); producerWakers = []; };

        // ── Push a paragraph — blocks when buffer is full (back-pressure) ──
        const push = async (item: { file: string; paragraph: string }): Promise<void> => {
            while (buffered >= TXT_BUFFER_HIGH_WATERMARK) {
                await new Promise<void>((r) => producerWakers.push(r));
                if (workerError) return; // abort if consumer threw
            }
            outBuffer.enqueue(item);
            buffered++;
            wakeConsumer();
        };

        // ── Listing pump: feeds fileQueue page-by-page ──────────────────────
        const listPump = async (): Promise<void> => {
            let continuationToken: string | undefined;
            try {
                do {
                    // FIX: use the caller-supplied prefix, not a hardcoded "docs"
                    const listResponse = await this.storage.list(prefix, continuationToken);
                    for (const item of listResponse.files) {

                        if (item.name?.endsWith(".txt")) {
                            fileQueue.enqueue({
                                key: item.key,
                                size: item.size ?? 0,
                                lastModified: item.lastModified,
                            });
                        }
                    }
                    continuationToken = listResponse.nextToken;
                } while (continuationToken);
            } finally {
                listDone = true;
            }
        };
        const worker = async (): Promise<void> => {
            while (true) {
                const file = fileQueue.dequeue();
                if (!file) {
                    if (listDone) break;
                    await new Promise<void>((r) => setTimeout(r, 0));
                    continue;
                }
                let carry = "";
                const res = await this.storage.readStream(file.key);

                for await (const rawChunk of res) {
                    if (this.signal?.aborted) return;
                    carry += (rawChunk as Buffer).toString("utf-8");
                    const parts = carry.split("\n\n");
                    carry = parts.pop()!;        // last part may be incomplete
                    for (const p of parts) {
                        if (p.trim()) await push({ file: file.key, paragraph: p });
                    }
                }

                if (carry.trim()) await push({ file: file.key, paragraph: carry });
            }
        };

        // ── Launch listing pump + workers concurrently ──────────────────────
        const pipeline = Promise.all([
            listPump(),
            ...Array.from({ length: workerCount }, worker),
        ])
            .then(() => { workersDone = true; wakeConsumer(); })
            .catch((err) => { workerError = err; workersDone = true; wakeConsumer(); });

        // ── Consumer loop ────────────────────────────────────────────────────
        try {
            while (!workersDone || !outBuffer.empty) {
                if (workerError) throw workerError;
                if (!outBuffer.empty) {
                    const item = outBuffer.dequeue()!;
                    buffered--;
                    wakeProducers();     // unblock any back-pressured worker
                    yield item;
                } else {
                    await new Promise<void>((r) => (consumerWaker = r));
                }
            }
            if (workerError) throw workerError;
        } finally {
            await pipeline;
        }
    }

    async *read_md_files(prefix: string, workerCount = 4): AsyncGenerator<Chunk> {
        const fileQueue = new PointerQueue<S3File>();
        let listDone = false;
        const listPump = async (): Promise<void> => {
            let continuationToken: string | undefined;
            try {
                do {
                    const listResponse = await this.storage.list(prefix, continuationToken);
                    for (const item of listResponse.files) {
                        if (item.key?.endsWith(".md")) {
                            fileQueue.enqueue({
                                key: item.key,
                                size: item.size ?? 0,
                                lastModified: item.lastModified,
                            });
                        }
                    }
                    continuationToken = listResponse.nextToken;
                } while (continuationToken);
            } finally {
                listDone = true;
            }
        };

        const queue = new AsyncQueue<Chunk>(MD_QUEUE_HIGH_WATERMARK);
        let workerError: unknown = null;

        const mdWorker = async (): Promise<void> => {
            while (true) {
                const file = fileQueue.dequeue();
                if (!file) {
                    if (listDone) break;
                    await new Promise<void>((r) => setTimeout(r, 0));
                    continue;
                }
                if (this.signal?.aborted || queue.closed) break;
                await this.parseAndPush(
                    file.key,
                    this.readWithTimeout(file),
                    queue
                );
            }
        };

        const pipeline = Promise.all([
            listPump(),
            ...Array.from({ length: workerCount }, mdWorker),
        ])
            .then(() => queue.close())
            .catch((err) => { workerError = err; queue.close(); });

        for await (const chunk of queue) {
            if (this.signal?.aborted) break;
            yield chunk;
        }

        await pipeline;
        if (workerError) throw workerError;
    }

    private readWithTimeout(filePath: S3File): Promise<AsyncIterable<Buffer>> {
        const readPromise = this.storage.readStream(filePath.key);
        const timeoutPromise = new Promise<never>((_, reject) => {
            const id = setTimeout(
                () => reject(new Error(
                    `Read timeout after ${this.readTimeoutMs}ms: "${filePath.key}"`
                )),
                this.readTimeoutMs
            );
            readPromise.then(() => clearTimeout(id), () => clearTimeout(id));
        });
        return Promise.race([readPromise, timeoutPromise]);
    }

    private async parseAndPush(
        filePath: string,
        streamPromise: Promise<AsyncIterable<Buffer>>,
        queue: AsyncQueue<Chunk>
    ): Promise<number> {
        const stream = await streamPromise;
        const chunks: Buffer[] = [];
        for await (const rawChunk of stream) {
            chunks.push(rawChunk as Buffer);
        }
        const content = Buffer.concat(chunks).toString("utf-8");

        let chunkCount = 0;
        for (const chunk of chunkMarkdown(content, filePath)) {
            if (this.signal?.aborted || queue.closed) break;
            await queue.enqueue(chunk);
            chunkCount++;
        }
        return chunkCount;
    }
}