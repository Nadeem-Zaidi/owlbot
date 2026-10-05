import OpenAI from "openai";
import { createHash } from "node:crypto";
import dotenv from "dotenv";
import { IVectorDb } from "../../interfaces/vectordb/ivector";
import { Chunk, IFileStore } from "../../interfaces/ifilestore";
import { S3Reader } from "../../file_reader/s3_reader";
dotenv.config();

const EMBEDDING_MODEL = "text-embedding-3-small";
const PIPELINE_BATCH = 30;
const DEFAULT_READ_TIMEOUT_MS = 3000;
// The embeddings endpoint takes up to 2048 inputs / 8192 tokens each; stay
// well under both so one big document doesn't fail as a single request.
const EMBED_BATCH = 64;
const MAX_INPUT_CHARS = 24_000;

export class Embedder {
    private client: OpenAI;
    private model: string;
    private storage: IFileStore;
    private reader: S3Reader;
    private vectorDb: IVectorDb;

    constructor(
        apiKey: string,
        model: string = EMBEDDING_MODEL,
        storage: IFileStore,
        vectorDb: IVectorDb,
        readTimeoutMs: number = DEFAULT_READ_TIMEOUT_MS
    ) {
        if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
        this.client = new OpenAI({ apiKey });
        this.model = model;
        this.storage = storage;
        this.vectorDb = vectorDb;
        this.reader = new S3Reader(storage, readTimeoutMs);
    }

    async embed(chunk: Chunk): Promise<number[]> {
        const text = this.chunkToText(chunk);
        const res = await this.client.embeddings.create({
            model: this.model,
            input: text,
        });
        return res.data[0].embedding;
    }

    async embedBatch(chunks: Chunk[]): Promise<number[][]> {
        const inputs = chunks.map((c) => this.chunkToText(c));
        const vectors: number[][] = [];
        for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
            const res = await this.client.embeddings.create({
                model: this.model,
                input: inputs.slice(i, i + EMBED_BATCH),
            });
            // The API returns one item per input, tagged with its index.
            for (const d of [...res.data].sort((a, b) => a.index - b.index)) vectors.push(d.embedding);
        }
        return vectors;
    }

    // What actually gets embedded. Naming the document and the full heading
    // path anchors each chunk to its topic, so a bare paragraph like "Click
    // Save to finish" isn't a near-match for every "how do I save" question.
    private chunkToText(chunk: Chunk): string {
        const docName = (chunk.sourceFile.split("/").pop() ?? chunk.sourceFile)
            .replace(/\.[^.]+$/, "")
            .replace(/[_-]+/g, " ");
        let text = `Document: ${docName}\n`;
        if (chunk.heading) {
            text += `Section: ${chunk.heading}\n`;
        }
        text += chunk.content;
        for (const cb of chunk.codeBlocks) {
            text += `\nCode (${cb.lang}):\n${cb.value}\n`;
        }
        return text.trim().slice(0, MAX_INPUT_CHARS);
    }

    async embedText(text: string): Promise<number[]> {
        const res = await this.client.embeddings.create({
            model: this.model,
            input: text.slice(0, MAX_INPUT_CHARS),
        });
        return res.data[0].embedding;
    }

    async ingest(prefix: string, worker = 4): Promise<{ totalChunks: number; totalBatches: number }> {
        await this.vectorDb.initialize();

        let totalChunks = 0;
        let totalBatches = 0;
        const buffer: Chunk[] = [];

        const flushBuffer = async () => {
            if (buffer.length === 0) return;
            const toFlush = buffer.splice(0, buffer.length); // snapshot + clear in one step

            try {
                const vectors = await this.embedBatch(toFlush);
                const items = toFlush.map((chunk, i) => ({
                    vector: vectors[i],
                    chunk,
                    id: stableId(chunk),
                }));
                await this.vectorDb.upsertManyChunks(items);

                totalBatches++;
                console.log(
                    `[pipeline] batch ${totalBatches} → ${toFlush.length} chunks upserted ` +
                    `(total read so far: ${totalChunks})`
                );
            } catch (error) {
                throw new Error(`Failed to embed/upsert batch of ${toFlush.length} chunks: ${error}`);
            }
        };

        try {
            for await (const chunk of this.reader.read_md_files(prefix, worker)) {
                buffer.push(chunk);
                totalChunks++;

                if (buffer.length >= PIPELINE_BATCH) {
                    await flushBuffer();
                }
            }
            await flushBuffer();

            console.log(`\n✓ ingestion complete — ${totalChunks} chunks across ${totalBatches} batches`);
            return { totalChunks, totalBatches };
        } catch (error) {
            console.error(
                `[pipeline] ingestion failed after ${totalChunks} chunks read, ${totalBatches} batches flushed:`,
                error
            );
            throw error;
        }
    }

    async embedAndStore(chunks: Chunk[]): Promise<string[]> {
        if (chunks.length === 0) return [];
        const vectors = await this.embedBatch(chunks);
        const items = chunks.map((chunk, i) => ({
            id: stableId(chunk),
            vector: vectors[i],
            chunk,
        }));
        await this.vectorDb.upsertManyChunks(items);
        return items.map((i) => i.id);
    }

    async deleteVectors(ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await this.vectorDb.delete(ids);
    }

    async deleteBySourceFiles(sourceFiles:string[]){
        if(sourceFiles.length==0) return ;
        await Promise.all(sourceFiles.map((sf)=>this.vectorDb.deleteBySourceFile(sf)));

    }

}

// Content hash → UUID-shaped id. Same chunk re-indexed = same row (upsert),
// and sha256 makes two different chunks sharing an id practically impossible.
function stableId(chunk: Chunk): string {
    const raw =
        `${chunk.sourceFile}::${chunk.heading}::${chunk.level}::${chunk.content}` +
        `::${chunk.tables.map((t) => t.headers.join(",") + t.rows.map((r) => r.join(",")).join(";")).join("|")}` +
        `::${chunk.codeBlocks.map((c) => c.lang + c.value).join("|")}`;
    const h = createHash("sha256").update(raw).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
