import { Chunk } from "../ifilestore";



export interface VectorSearchResult {
  id: string;
  score: number;
  payload?: Record<string, any>;
}

export interface IVectorDb {
  initialize(): Promise<void>;
  upsert(id: string, vector: number[], payload: Record<string, any>): Promise<void>;
  upsertMany(ids: string[], vectors: number[][], payloads: Array<Record<string, any>>): Promise<void>;
  search(vector: number[], limit?: number, withPayload?: boolean): Promise<VectorSearchResult[]>;
  delete(ids: string[]): Promise<void>;
  upsertChunk(id: string, vector: number[], chunk: Chunk): Promise<void>;
  upsertManyChunks(chunks: Array<{ id: string; vector: number[]; chunk: Chunk }>): Promise<void>;
  deleteBySourceFile(sourceFile: string): Promise<void>;
}

