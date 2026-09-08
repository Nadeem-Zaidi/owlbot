import OpenAI from "openai";
import dotenv from "dotenv";
import { IVectorDb } from "../../interfaces/vectordb/ivector";
import { Chunk, IFileStore } from "../../interfaces/ifilestore";
import { S3Reader } from "../../file_reader/s3_reader";
dotenv.config();

const EMBEDDING_MODEL = "text-embedding-3-small";
const PIPELINE_BATCH = 30;
const DEFAULT_READ_TIMEOUT_MS = 3000;

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
        const res = await this.client.embeddings.create({
            model: this.model,
            input: inputs,
        });
        return res.data.map((d) => d.embedding);
    }

    private chunkToText(chunk: Chunk): string {
        let text = "";
        if (chunk.heading) {
            text += `Section: ${chunk.heading}\n`;
        }
        text += chunk.content;
        for (const cb of chunk.codeBlocks) {
            text += `\nCode (${cb.lang}):\n${cb.value}\n`;
        }
        return text.trim();
    }

    async embedText(text: string): Promise<number[]> {
        const res = await this.client.embeddings.create({
            model: this.model,
            input: text,
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

function stableId(chunk: Chunk): string {
    const raw =
        `${chunk.sourceFile}::${chunk.heading}::${chunk.level}::${chunk.content}` +
        `::${chunk.tables.map((t) => t.headers.join(",") + t.rows.map((r) => r.join(",")).join(";")).join("|")}` +
        `::${chunk.codeBlocks.map((c) => c.lang + c.value).join("|")}`;
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
        hash = ((hash << 5) + hash) ^ raw.charCodeAt(i);
        hash = hash >>> 0;
    }
    return `${hash.toString(16).padStart(8, "0")}-${raw.length.toString(16).padStart(4, "0")}-0000-0000-000000000000`;
}