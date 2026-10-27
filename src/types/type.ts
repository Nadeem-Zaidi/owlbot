import { IDatabaseAdapter } from "../database/idatabaseadapter";

export interface Migration {
  version: string;
  description: string;
  up: string | string[];
  down: string | string[];
}

export interface MigrationRecord {
  id?: number;
  version: string;
  description: string;
  applied_at: Date;
  execution_time_ms: number;
}

export interface MigrationResult {
  success: boolean;
  version: string;
  description: string;
  executionTime: number;
  error?: string;
}

export interface MigrationStatus {
  pending: Migration[];
  applied: MigrationRecord[];
  current: string | null;
}

export type S3Config = {
  region: string,
  accesskeyid: string;
  secretaccesskey: string;
}

export type QDConfig = {
  url: string,
  size: number,
  collectionname: string,

}

export interface S3File {
  key: string;
  size: number;
  lastModified?: Date;

}
export interface ListResult {
  folders: any[];
  files: any[];
  nextToken?: string;
}

export type LLMConfig = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
}

export type FolderListToSend = {
  type: string;
  name: string;
  path: string;
}

export type FileListToSend = {
  type: string,
  name: string,
  prefix: string,
  key: string,
  size: number,
  lastModified: string
}

export type FileToSend = FileListToSend | FolderListToSend;

export interface ToolContext {
  db: IDatabaseAdapter;
  // Who the tool runs for — tools must only touch this user's data.
  userId?: string;
  // The chat the tool runs in (e.g. to attach a created document to it).
  sessionId?: string;
  // Knowledge-base folder to use instead of the user's own (team workspace).
  kbScope?: string;
  // The running answer's Stop signal, and a way to send a live event to the
  // chat while the tool runs (e.g. a request for the desktop app). Only set
  // inside a provider's tool loop.
  signal?: AbortSignal;
  emit?: (event: Record<string, unknown> & { type: string }) => void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: any[];
      // Nested JSON Schema (arrays of objects, e.g. an Excel file's sheets).
      items?: Record<string, any>;
      properties?: Record<string, any>;
      required?: string[];
    }>;
    required: string[];
  };
  execute: (
    args: Record<string, any>,
    ctx: ToolContext
  ) => Promise<any> | any;
  // Safe to run at the same time as other parallel tools of the same turn
  // (no side effects, never asks the user anything).
  parallel?: boolean;
  // Part of an opt-in tool pack (e.g. "documents"): only offered to the model
  // when that pack is turned on for the run (ChatRunOptions.toolPacks).
  pack?: string;
}

export type Session={
  id:string
  userid:string
  title:string
  model?:string|null
  created_at:string
  updated_at:string
  pinned_at?:string|null

}


export type Tool={
  type:string,
  name :string,
  description:string,
  paramaetrs:{
    type:string,
    properties:Record<string,string>
  }
}
