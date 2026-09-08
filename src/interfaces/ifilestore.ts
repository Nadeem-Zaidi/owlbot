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
  uploadAndGetUrls(files: { buffer: Buffer; originalname: string; mimetype: string }[],prefix:string): Promise<{ originalname: string; key: string; url: string }[]>
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
