export interface FileEntry {
  key: string;
  size?: number;
  lastModified?: Date;
}

export interface FolderEntry {
  name: string;
  path: string;
}

export interface ListResult {
  folders: FolderEntry[];
  files: (FileEntry & { url?: string; name?: string; prefix?: string })[];
  nextToken?: string;
}

export interface IFileStore {
  list(
    prefix: string,
    continuationToken?: string,
    options?: { delimiter?: string; includeUrls?: boolean }
  ): Promise<ListResult>;
  readStream(key: string): Promise<AsyncIterable<Buffer>>;
  move(source: string, destination: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
  deleteFolder(path: string): Promise<void>;
  createFolder(folderName: string): Promise<void>;
  upload(files: { buffer: Buffer; originalname: string; mimetype: string }[], prefix?: string): Promise<void>;
  // `options.expiresInSeconds` lets a caller ask for a longer-lived signed
  // URL than the 1-hour default (e.g. code-interpreter-generated charts,
  // which should stay viewable in chat history far longer than a fresh
  // upload's share link needs to). Capped by S3 SigV4 itself at 7 days.
  uploadAndGetUrls(files: { buffer: Buffer; originalname: string; mimetype: string }[],prefix:string, options?: { expiresInSeconds?: number }): Promise<{ originalname: string; key: string; url: string }[]>
}

export interface CodeBlock {
  lang: string;
  value: string;
}


export interface Chunk {
  heading: string;
  level: number;
  content: string;
  sourceFile: string;
  codeBlocks: { lang: string; value: string }[];
  tables: { headers: string[]; rows: string[][] }[];
}
