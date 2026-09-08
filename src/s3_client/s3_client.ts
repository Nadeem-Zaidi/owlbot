import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  GetObjectCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "stream";
import { IFileStore, Chunk } from "../interfaces/ifilestore";
import { ListResult } from "../types/type";

export interface S3Config {
  region: string;
  accesskeyid: string;
  secretaccesskey: string;
}

export class S3FileStore implements IFileStore {
  private readonly s3Client: S3Client;

  constructor(private readonly bucket: string, private readonly config: S3Config, private readonly signal?: AbortSignal) {
    this.s3Client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accesskeyid,
        secretAccessKey: config.secretaccesskey,
      },
    });
  }
  async uploadAndGetUrls(
    files: { buffer: Buffer; originalname: string; mimetype: string }[],
    prefix = ""
  ): Promise<{ originalname: string; key: string; url: string }[]> {
    const results: { originalname: string; key: string; url: string }[] = new Array(files.length);
    let index = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const i = index++;
        if (i >= files.length) break;
        const file = files[i];
        const key = `${prefix}${file.originalname}`;

        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
          })
        );

        const url = await this.getSignedUrlFor(key);
        results[i] = { originalname: file.originalname, key, url };
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(5, files.length) }, worker));
      return results;
    } catch (error) {
      throw new Error(`Upload failed: ${error}`);
    }
  }
  async list(
    prefix: string,
    continuationToken?: string,
    options?: { delimiter?: string; includeUrls?: boolean }
  ): Promise<ListResult> {
    try {
      console.log("Querying bucket:", JSON.stringify(this.bucket)); // JSON.stringify reveals hidden whitespace/newlines
      const page = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: options?.delimiter,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        })
      );

      const folders = (page.CommonPrefixes ?? []).map((f) => ({
        name: f.Prefix?.replace(prefix, "").replace(/\/$/, "") ?? "",
        path: f.Prefix ?? "",
      }));

      const files: ListResult["files"] = [];
      for (const f of page.Contents ?? []) {
        if (!f.Key || f.Key.endsWith("/")) continue;
        const url = options?.includeUrls ? await this.getSignedUrlFor(f.Key) : undefined;
        files.push({
          key: f.Key,
          name: f.Key.replace(prefix, ""),
          prefix,
          size: f.Size,
          lastModified: f.LastModified,
          url,
        });
      }

      return { folders, files, nextToken: page.IsTruncated ? page.NextContinuationToken : undefined };
    } catch (error) {
      throw new Error(`Failed to list files at "${prefix}": ${error}`);
    }
  }

  async getSignedUrlFor(key: string): Promise<string> {
    return getSignedUrl(this.s3Client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: 3600,
    });
  }

  async readStream(key: string): Promise<AsyncIterable<Buffer>> {
    const res = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`No body for "${key}"`);
    return res.Body as Readable; // Readable is AsyncIterable<Buffer>
  }

  async createFolder(folderName: string): Promise<void> {
    const key = folderName.endsWith("/") ? folderName : `${folderName}/`;
    try {
      await this.s3Client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: "", ContentType: "application/x-directory" })
      );
    } catch (error) {
      throw new Error(`Failed to create folder "${folderName}": ${error}`);
    }
  }

  async upload(
    files: { buffer: Buffer; originalname: string; mimetype: string }[],
    prefix = ""
  ): Promise<void> {
    let index = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = index++;
        if (i >= files.length) break;
        const file = files[i];
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: `${prefix}${file.originalname}`,
            Body: file.buffer,
            ContentType: file.mimetype,
          })
        );
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(5, files.length) }, worker));
    } catch (error) {
      throw new Error(`Upload failed: ${error}`);
    }
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      try {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
          })
        );
      } catch (error) {
        throw new Error(`Error deleting files (batch ${i}-${i + batch.length}): ${error}`);
      }
    }
  }

  async deleteFolder(prefix: string): Promise<void> {
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    let continuationToken: string | undefined;
    try {
      do {
        const listResponse = await this.s3Client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: normalizedPrefix,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          })
        );
        const objects = listResponse.Contents;
        if (!objects?.length) break;

        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects.map((obj) => ({ Key: obj.Key! })), Quiet: true },
          })
        );

        continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (error) {
      throw new Error(`Failed to delete folder "${prefix}": ${error}`);
    }
  }

  async move(source: string, destination: string): Promise<void> {
    let nextToken: string | undefined;
    const CONCURRENCY = 10;

    const moveObject = async (obj: _Object): Promise<void> => {
      if (!obj.Key) return;
      const newKey = obj.Key.replace(source, destination);
      await this.s3Client.send(
        new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${obj.Key}`, Key: newKey })
      );
      await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: obj.Key }));
    };

    try {
      do {
        const listResponse = await this.s3Client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: source,
            ContinuationToken: nextToken,
            MaxKeys: 1000,
          })
        );
        const batch = listResponse.Contents ?? [];
        for (let i = 0; i < batch.length; i += CONCURRENCY) {
          await Promise.all(batch.slice(i, i + CONCURRENCY).map(moveObject));
        }
        nextToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
      } while (nextToken);
    } catch (error) {
      throw new Error(`Failed to move "${source}" -> "${destination}": ${error}`);
    }
  }
}