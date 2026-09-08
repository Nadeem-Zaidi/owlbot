import { QdrantClient } from "@qdrant/js-client-rest";
import { IVectorDb } from "../../interfaces/vectordb/ivector";
import { QDConfig } from "../../types/type";
import { Chunk } from "../../interfaces/ifilestore";
import { randomUUID } from "node:crypto";

export class QDRantDb {
    private config: QDConfig;
    private client: QdrantClient;
    private static readonly BATCH_SIZE = 100;

    constructor(config: QDConfig) {
        if (!config.url) throw new Error("QDRant config missing : url");
        if (!config.collectionname) throw new Error("QDrant config missing:collectionName");
        if (!config.size) throw new Error("QDrant config missing:size");
        this.config = config;
        this.client = new QdrantClient({ url: config.url });
    }

    private chunkToPayload(chunk: Chunk) {
        return ({
            heading: chunk.heading,
            level: chunk.level,
            text: chunk.content,
            sourdeFile: chunk.sourceFile,
            codeBlocks: chunk.codeBlocks,
            tables: chunk.tables
        })

    }
    async ensureCollection(): Promise<void> {
        const result = await this.client.collectionExists(this.config.collectionname);
        if (!result.exists) {
            await this.client.createCollection(this.config.collectionname, {
                vectors: {
                    size: this.config.size,
                    distance: "Cosine"
                }
            });
        }

    }
    async upsert(id: string, vector: number[], payload: Record<string, any>): Promise<void> {
        await this.client.upsert(this.config.collectionname, {
            wait: true,
            points: [
                {
                    id: id,
                    vector: vector,
                    payload: payload
                }
            ]
        })

    }
    async upsertChunk(id: string, vector: number[], chunk: Chunk): Promise<void> {

        await this.client.upsert(this.config.collectionname, {
            wait: true,
            points: [
                {
                    id: id,
                    vector: vector,
                    payload: this.chunkToPayload(chunk)
                }

            ]
        })
    }

    async upsertManyChunks(chunks: Array<{ id: string; vector: number[]; chunk: Chunk; }>): Promise<void> {
        const points = chunks.map(({ id, vector, chunk }) => ({
            id: id ?? randomUUID(),
            vector: vector,
            payload: this.chunkToPayload(chunk)

        }));

        for (let i = 0; i < points.length; i += QDRantDb.BATCH_SIZE) {
            const batch = points.slice(i, i + QDRantDb.BATCH_SIZE)
            await this.client.upsert(this.config.collectionname, {
                wait: true,
                points: batch
            });
            console.log(`[QDrant_Db] upserted batch ${Math.floor(i / QDRantDb.BATCH_SIZE) + 1} (${batch.length} points)`);

        }
    }

    async upsertMany(ids: string[], vectors: number[][], payloads: Array<Record<string, any>>): Promise<void> {
        if (ids.length != vectors.length || ids.length != payloads.length) {
            throw new Error("Ids length should be equal to Vectors lenght and payload length")
        }

        const points = ids.map((id, i) => ({ id, vector: vectors[i], payload: payloads[i] }))

        for (let i = 0; i <= ids.length; i += QDRantDb.BATCH_SIZE) {
            await this.client.upsert(this.config.collectionname, {
                wait: true,
                points: points.slice(i, i + QDRantDb.BATCH_SIZE)
            })
        }

    }
    async search(vector: number[], limit: number = 10, withPayload: boolean = true): Promise<string> {
        const results = await this.client.query(this.config.collectionname, {
            query: vector,
            limit,
            with_payload: withPayload,
        });

        return results.points
            .map((point: any) => {
                const p = point.payload;
                if (!p) return null;

                let content = p.heading ? `## ${p.heading}\n` : "";
                content += p.text ?? "";

                if (Array.isArray(p.codeBlocks) && p.codeBlocks.length > 0) {
                    for (const cb of p.codeBlocks) {
                        content += `\`\`\`${cb.lang}\n${cb.value}\n\`\`\`\n`;
                    }
                }

                if (Array.isArray(p.tables) && p.tables.length > 0) {
                    for (const table of p.tables) {
                        content += `\n| ${table.headers.join(" | ")} |\n`;
                        content += `| ${table.headers.map(() => "---").join(" | ")} |\n`;
                        for (const row of table.rows) {
                            content += `| ${row.join(" | ")} |\n`;
                        }
                    }
                }

                if (p.sourceFile) content += `\n*Source: ${p.sourceFile}*`;

                return content.trim();
            })
            .filter(Boolean)
            .join("\n\n---\n\n");
    }

    async delete(ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await this.client.delete(this.config.collectionname, { wait: true, points: ids });
        console.log(`[QDrant_Db] deleted ${ids.length} point(s)`);
    }

}
