import { Chunk } from "../interfaces/ifilestore";
import { IVectorDb, VectorSearchResult } from "../interfaces/vectordb/ivector";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import pgvector from "pgvector/pg";

// NEW — `content` is now a real, confirmed field on Chunk (per your
// Embedder.chunkToText), and it's the one thing the table was missing.
// sourceFile/heading are confirmed too — no more `as any` guessing needed
// for those three.
type VectorPayload = {
  source_file: string;
  heading?: string;
  content: string; // NEW
  metadata?: Record<string, any>;
};

const TABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Mirrors Embedder.chunkToText's composition (heading + content + code
 * blocks) so what gets stored as retrievable text is exactly what was
 * embedded — a search result's score and its displayed content should
 * always correspond to the same string. This duplicates a few lines from
 * your Embedder class rather than importing a private method; if you'd
 * rather have one source of truth, promote Embedder's chunkToText to an
 * exported function and both call it.
 */
function composeChunkText(chunk: Chunk): string {
  let text = "";
  if (chunk.heading) text += `Section: ${chunk.heading}\n`;
  text += chunk.content;
  for (const cb of chunk.codeBlocks ?? []) {
    text += `\nCode (${cb.lang}):\n${cb.value}\n`;
  }
  return text.trim();
}

export class PostgresqlVectorDb implements IVectorDb {
  private static readonly EMBEDDING_DIM = 1536; // must match your embedding model's output size

  constructor(private db: IDatabaseAdapter, private table: string) {
    if (!TABLE_NAME_PATTERN.test(table)) {
      throw new Error(`Invalid table name "${table}"`);
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          id TEXT PRIMARY KEY,
          source_file TEXT NOT NULL,
          heading TEXT,
          content TEXT NOT NULL DEFAULT '',
          embedding VECTOR(${PostgresqlVectorDb.EMBEDDING_DIM}),
          metadata JSONB,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await this.db.query(`
        CREATE INDEX IF NOT EXISTS ${this.table}_embedding_idx
        ON ${this.table} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
      `);
    } catch (error) {
      throw new Error(`Failed to initialize vector table "${this.table}": ${error}`);
    }
  }

  async upsert(id: string, vector: number[], payload: Record<string, any>): Promise<void> {
    const { source_file, heading, content, metadata } = payload as VectorPayload; // NEW: content
    try {
      await this.db.query(
        `
          INSERT INTO ${this.table} (id, source_file, heading, content, embedding, metadata, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, now())
          ON CONFLICT (id) DO UPDATE SET
            source_file = EXCLUDED.source_file,
            heading = EXCLUDED.heading,
            content = EXCLUDED.content,
            embedding = EXCLUDED.embedding,
            metadata = EXCLUDED.metadata,
            updated_at = now()
        `,
        [id, source_file, heading ?? null, content ?? "", pgvector.toSql(vector), JSON.stringify(metadata ?? {})]
      );
    } catch (error) {
      throw new Error(`Failed to upsert vector "${id}": ${error}`);
    }
  }

  async upsertMany(
    ids: string[],
    vectors: number[][],
    payloads: Array<Record<string, any>>
  ): Promise<void> {
    if (ids.length !== vectors.length || ids.length !== payloads.length) {
      throw new Error("upsertMany: ids, vectors, and payloads must be the same length");
    }
    if (ids.length === 0) return;

    try {
      await this.db.withTransaction(async () => {
        for (let i = 0; i < ids.length; i++) {
          const { source_file, heading, content, metadata } = payloads[i] as VectorPayload; // NEW: content
          await this.db.query(
            `
              INSERT INTO ${this.table} (id, source_file, heading, content, embedding, metadata, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, now())
              ON CONFLICT (id) DO UPDATE SET
                source_file = EXCLUDED.source_file,
                heading = EXCLUDED.heading,
                content = EXCLUDED.content,
                embedding = EXCLUDED.embedding,
                metadata = EXCLUDED.metadata,
                updated_at = now()
            `,
            [ids[i], source_file, heading ?? null, content ?? "", pgvector.toSql(vectors[i]), JSON.stringify(metadata ?? {})]
          );
        }
      });
    } catch (error) {
      throw new Error(`Failed to upsert ${ids.length} vectors: ${error}`);
    }
  }

  async search(vector: number[], limit = 10, withPayload = true): Promise<VectorSearchResult[]> {
    try {
      const result = await this.db.query<{
        id: string;
        source_file: string;
        heading: string | null;
        content: string; // NEW
        metadata: Record<string, any> | null;
        score: number;
      }>(
        `
          SELECT
            id,
            source_file,
            heading,
            content,
            ${withPayload ? "metadata," : "NULL AS metadata,"}
            1 - (embedding <=> $1) AS score
          FROM ${this.table}
          ORDER BY embedding <=> $1
          LIMIT $2
        `,
        [pgvector.toSql(vector), limit]
      );

      return result.rows.map((row) => ({
        id: row.id,
        score: row.score,
        payload: withPayload
          ? {
              source_file: row.source_file,
              heading: row.heading ?? undefined,
              content: row.content, // NEW — the actual point of the search
              metadata: row.metadata ?? {},
            }
          : undefined,
      }));
    } catch (error) {
      throw new Error(`Vector search failed: ${error}`);
    }
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.db.query(`DELETE FROM ${this.table} WHERE id = ANY($1::text[])`, [ids]);
    } catch (error) {
      throw new Error(`Failed to delete ${ids.length} vectors: ${error}`);
    }
  }

  async upsertChunk(id: string, vector: number[], chunk: Chunk): Promise<void> {
    await this.upsert(id, vector, {
      source_file: chunk.sourceFile,
      heading: chunk.heading,
      content: composeChunkText(chunk), // NEW — was missing entirely before
      metadata: {},
    });
  }

  async upsertManyChunks(
    chunks: Array<{ id: string; vector: number[]; chunk: Chunk }>
  ): Promise<void> {
    if (chunks.length === 0) return;
    await this.upsertMany(
      chunks.map((c) => c.id),
      chunks.map((c) => c.vector),
      chunks.map((c) => ({
        source_file: c.chunk.sourceFile,
        heading: c.chunk.heading,
        content: composeChunkText(c.chunk), // NEW
        metadata: {},
      }))
    );
  }

  async deleteBySourceFile(sourceFile: string): Promise<void> {
    await this.db.query(
        `DELETE FROM ${this.table} WHERE source_file = $1`,
        [sourceFile]
    );
}
  
}