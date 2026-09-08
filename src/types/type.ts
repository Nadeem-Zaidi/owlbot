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
    }>;
    required: string[];
  };
  execute: (
    args: Record<string, any>,
    ctx: ToolContext
  ) => Promise<any> | any;
}

export type Session={
  id:string
  userid:string
  title:string
  model?:string|null
  created_at:string
  updated_at:string

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
