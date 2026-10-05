import { Chunk } from "../interfaces/ifilestore";
import { IVectorDb, VectorSearchFilter, VectorSearchResult } from "../interfaces/vectordb/ivector";
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

// Added to the similarity of chunks that also match the query's keywords.
const KEYWORD_BONUS = 0.05;

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
      // HNSW: good recall at any size, no training step (unlike IVFFlat).
      await this.db.query(`DROP INDEX IF EXISTS ${this.table}_embedding_idx`);
      await this.db.query(`
        CREATE INDEX IF NOT EXISTS ${this.table}_embedding_hnsw
        ON ${this.table} USING hnsw (embedding vector_cosine_ops);
      `);
      // Keyword side of hybrid search: exact terms (error codes, names,
      // function names) that embeddings blur. Generated, so it never drifts.
      await this.db.query(`
        ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading, '') || ' ' || content)) STORED
      `);
      await this.db.query(`CREATE INDEX IF NOT EXISTS ${this.table}_tsv_gin ON ${this.table} USING gin (tsv)`);
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

  // Hybrid search: nearest neighbours by embedding, plus full-text matches
  // when `filter.text` is given; a keyword match earns a small boost. `score` is always
  // the cosine similarity, and `filter.minScore` drops anything below it —
  // without a floor, the "closest" chunks of unrelated documents come back
  // for every query, however far away they are.
  async search(vector: number[], limit = 10, withPayload = true, filter: VectorSearchFilter = {}): Promise<VectorSearchResult[]> {
    const conditions: string[] = [];
    const params: unknown[] = [pgvector.toSql(vector)];
    if (filter.prefix) {
      params.push(filter.prefix);
      conditions.push(`source_file LIKE $${params.length} || '%'`);
    }
    if (filter.sourceFiles?.length) {
      params.push(filter.sourceFiles);
      conditions.push(`source_file = ANY($${params.length}::text[])`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const and = conditions.length ? `${where} AND` : "WHERE";

    // Over-fetch candidates so the score floor and fusion have room to work.
    const candidates = Math.max(limit * 4, 20);
    params.push(candidates);
    const k = `$${params.length}`;
    const text = filter.text?.trim();
    let keywordCte = "";
    if (text) {
      params.push(text);
      keywordCte = `,
        kw AS (
          SELECT id, row_number() OVER () AS rnk FROM (
            SELECT id FROM ${this.table}, websearch_to_tsquery('english', $${params.length}) q
            ${and} tsv @@ q
            ORDER BY ts_rank_cd(tsv, q) DESC
            LIMIT ${k}
          ) s
        )`;
    }

    const sql = `
      WITH vec AS (
        SELECT id, row_number() OVER () AS rnk FROM (
          SELECT id FROM ${this.table} ${where}
          ORDER BY embedding <=> $1
          LIMIT ${k}
        ) s
      )${keywordCte}
      SELECT t.id, t.source_file, t.heading, t.content,
             ${withPayload ? "t.metadata," : "NULL AS metadata,"}
             1 - (t.embedding <=> $1) AS score,
             ${text ? "kw.rnk IS NOT NULL" : "false"} AS keyword_hit
      FROM ${this.table} t
      JOIN (SELECT id FROM vec${text ? " UNION SELECT id FROM kw" : ""}) ids ON ids.id = t.id
      LEFT JOIN vec ON vec.id = t.id
      ${text ? "LEFT JOIN kw ON kw.id = t.id" : ""}
    `;

    type Row = {
      id: string; source_file: string; heading: string | null; content: string;
      metadata: Record<string, any> | null; score: number; keyword_hit: boolean;
    };
    let rows: Row[];
    try {
      rows = await this.db.withTransaction(async () => {
        // With a WHERE filter, a plain HNSW scan returns the global nearest
        // neighbours and *then* filters — often leaving fewer than `limit`
        // rows from this user. Iterative scan keeps going until it has enough.
        if (where) {
          await this.db.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
          await this.db.query(`SET LOCAL hnsw.ef_search = 100`);
        }
        return (await this.db.query<Row>(sql, params)).rows;
      });
    } catch (error) {
      throw new Error(`Vector search failed: ${error}`);
    }

    const minScore = filter.minScore ?? 0;
    // A chunk containing the exact query terms may sit a bit below the
    // floor (embeddings undervalue rare words like codes and names).
    const keywordFloor = minScore * 0.75;
    // Ranking: similarity, nudged up when the chunk also contains the query's
    // words. A bonus rather than rank fusion, so a keyword-only hit can't
    // jump ahead of a far closer semantic match.
    const ranked = rows.map((r) => {
      const score = Number(r.score);
      return { ...r, score, rank: score + (r.keyword_hit ? KEYWORD_BONUS : 0) };
    });
    const best = Math.max(0, ...ranked.map((r) => r.rank));
    const margin = filter.relativeMargin;

    return ranked
      .filter((r) => r.score >= minScore || (r.keyword_hit && r.score >= keywordFloor))
      // Drop stragglers far below the best match — a 0.31 next to a 0.62 is
      // almost always a different topic that merely cleared the floor.
      .filter((r) => margin === undefined || r.rank >= best - margin)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        score: row.score,
        payload: withPayload
          ? {
              source_file: row.source_file,
              heading: row.heading ?? undefined,
              content: row.content,
              metadata: row.metadata ?? {},
              keyword_match: row.keyword_hit,
            }
          : undefined,
      }));
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

  // After re-indexing a document: removes its chunks from the previous
  // version (anything not in `keepIds`), so edited sections don't linger.
  async deleteStaleChunks(sourceFile: string, keepIds: string[]): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM ${this.table} WHERE source_file = $1 AND NOT (id = ANY($2::text[]))`,
      [sourceFile, keepIds]
    );
    return result.rowCount ?? 0;
  }

  // Distinct indexed documents under a key prefix (a user's folder), with
  // how many chunks each has — backs the "browse knowledge base" picker.
  async listSourceFiles(prefix: string): Promise<{ source_file: string; chunks: number; updated_at: Date }[]> {
    const result = await this.db.query<{ source_file: string; chunks: string; updated_at: Date }>(
      `
        SELECT source_file, COUNT(*) AS chunks, MAX(updated_at) AS updated_at
        FROM ${this.table}
        WHERE source_file LIKE $1 || '%'
        GROUP BY source_file
        ORDER BY MAX(updated_at) DESC
      `,
      [prefix]
    );
    return result.rows.map((r) => ({ source_file: r.source_file, chunks: Number(r.chunks), updated_at: r.updated_at }));
  }

  // Every chunk of one document. Chunk ids are content hashes, so there's no
  // stored position; ctid (physical row order) follows insertion order for
  // freshly indexed files, which is the order chunkMarkdown produced them in.
  // Good enough as a fallback when the converted .md copy isn't in storage.
  async getChunksBySourceFile(sourceFile: string): Promise<{ heading: string | null; content: string }[]> {
    const result = await this.db.query<{ heading: string | null; content: string }>(
      `SELECT heading, content FROM ${this.table} WHERE source_file = $1 ORDER BY ctid`,
      [sourceFile]
    );
    return result.rows;
  }

}