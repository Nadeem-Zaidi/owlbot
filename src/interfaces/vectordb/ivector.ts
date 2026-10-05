import { Chunk } from "../ifilestore";



export interface VectorSearchResult {
  id: string;
  score: number;
  payload?: Record<string, any>;
}

export type VectorSearchFilter = {
  prefix?: string;
  sourceFiles?: string[];
  // The query text — enables the keyword half of hybrid search.
  text?: string;
  // Cosine-similarity floor; results below it are dropped.
  minScore?: number;
  // Also drop results more than this far below the best match.
  relativeMargin?: number;
};

export interface IVectorDb {
  initialize(): Promise<void>;
  upsert(id: string, vector: number[], payload: Record<string, any>): Promise<void>;
  upsertMany(ids: string[], vectors: number[][], payloads: Array<Record<string, any>>): Promise<void>;
  // `filter` limits results to one user's folder (`prefix`) and/or specific documents.
  search(vector: number[], limit?: number, withPayload?: boolean, filter?: VectorSearchFilter): Promise<VectorSearchResult[]>;
  delete(ids: string[]): Promise<void>;
  upsertChunk(id: string, vector: number[], chunk: Chunk): Promise<void>;
  upsertManyChunks(chunks: Array<{ id: string; vector: number[]; chunk: Chunk }>): Promise<void>;
  deleteBySourceFile(sourceFile: string): Promise<void>;
  // Optional — used by the document browser / "explain this document" flow.
  listSourceFiles?(prefix: string): Promise<{ source_file: string; chunks: number; updated_at: Date }[]>;
  // Optional — drops a document's chunks that aren't in `keepIds` (re-index).
  deleteStaleChunks?(sourceFile: string, keepIds: string[]): Promise<number>;
  getChunksBySourceFile?(sourceFile: string): Promise<{ heading: string | null; content: string }[]>;
}

