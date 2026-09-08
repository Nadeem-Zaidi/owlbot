import { QdrantClient } from "@qdrant/js-client-rest";
import { Chunk } from "../interfaces/ifilestore";
import { IVectorDb } from "../interfaces/vectordb/ivector";
import { QDConfig } from "../types/type";

export class QDrant_Db implements IVectorDb {
    private config: QDConfig;
    private client: QdrantClient;


    constructor(config: QDConfig) {
        if (!config.url) throw new Error("QDrant config missing: url");
        if (!config.collectionname) throw new Error("QDrant config missing: collectionname");
        if (!config.size) throw new Error("QDrant config missing: size");
        this.config = config;
        this.client = new QdrantClient({ url: config.url });

    }

    async initialize(): Promise<void> {
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
        });
    }

    // upsert a Chunk — embeds text content, stores code blocks as metadata
    async upsertChunk(id: string, vector: number[], chunk: Chunk): Promise<void> {
        const payload: Record<string, any> = {
            source_file: chunk.sourceFile,
            heading: chunk.heading,
            level: chunk.level,
            // plain text stored for retrieval context
            text: chunk.content,
            // code blocks stored separately as metadata
            codeBlocks: chunk.codeBlocks.map(cb => ({
                lang: cb.lang,
                value: cb.value
            }))
        };

        await this.client.upsert(this.config.collectionname, {
            wait: true,
            points: [
                {
                    id: id,
                    vector: vector,
                    payload: payload
                }
            ]
        });
    }

    async upsertManyChunks(chunks: Array<{ id: string; vector: number[]; chunk: Chunk }>): Promise<void> {
        const points = chunks.map(({ id, vector, chunk }) => ({
            id: id,
            vector: vector,
            payload: {
                source_file: chunk.sourceFile,
                heading: chunk.heading,
                level: chunk.level,
                text: chunk.content,
                codeBlocks: chunk.codeBlocks.map(cb => ({
                    lang: cb.lang,
                    value: cb.value
                }))
            }
        }));

        await this.client.upsert(this.config.collectionname, {
            wait: true,
            points: points
        });
    }

    upsertMany(ids: string[], vectors: number[][], payloads: Array<Record<string, any>>): Promise<void> {
        throw new Error("Method not implemented.");
    }

    async search(vector: number[], limit?: number, withPayload?: boolean): Promise<any> {
        const results = await this.client.query(this.config.collectionname, {
            query: vector,
            limit: Number(50),        // ✅ force convert to number
            with_payload: withPayload
        });

        const context = results.points
            .map((point: any) => {
                const payload = point.payload;
                if (!payload) return null;

                let content = payload.heading ? `## ${payload.heading}\n` : "";
                content += payload.text ?? "";

                if (Array.isArray(payload.codeBlocks)) {
                    for (const cb of payload.codeBlocks) {
                        content += `\`\`\`${cb.lang}\n${cb.value}\n\`\`\`\n`;
                    }
                }

                return content;
            })
            .filter(Boolean)
            .join("\n\n---\n\n");

        return context;
    }

    delete(ids: string[]): Promise<void> {
        throw new Error("Method not implemented.");
    }

    async deleteBySourceFile(sourceFile: string): Promise<void> {
        await this.client.delete(this.config.collectionname, {
            wait: true,
            filter: {
                must: [
                    { key: "source_file", match: { value: sourceFile } }
                ]
            }
        });
    }
}