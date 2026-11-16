import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { Config } from "./config.js";
import { AppError, digest } from "./model.js";
export interface Objects {
  put(
    key: string,
    data: Buffer,
    mediaType: string,
    sha256: string,
  ): Promise<void>;
  get(key: string, maxBytes: number): Promise<Buffer>;
  ready(): Promise<void>;
  close(): void;
}
export class S3Objects implements Objects {
  readonly client: S3Client;
  constructor(private config: Config) {
    this.client = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.s3AccessKey,
        secretAccessKey: config.s3SecretKey,
      },
      maxAttempts: 3,
    });
  }
  async put(key: string, data: Buffer, mediaType: string, sha256: string) {
    if (digest(data) !== sha256)
      throw new AppError(
        500,
        "checksum_mismatch",
        "File integrity verification failed.",
      );
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: key,
          Body: data,
          ContentLength: data.length,
          ContentType: mediaType,
          Metadata: { sha256 },
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "PreconditionFailed" ||
          error.name === "ConditionalRequestConflict")
      ) {
        const existing = await this.get(key, data.length);
        if (digest(existing) === sha256) return;
      }
      throw error;
    }
  }
  async get(key: string, maxBytes: number) {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.s3Bucket, Key: key }),
    );
    if (!(response.Body instanceof Readable))
      throw new Error("object_body_missing");
    const body = response.Body;
    if ((response.ContentLength ?? Infinity) > maxBytes) {
      body.destroy();
      throw new Error("object_size_limit");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        body.destroy();
        throw new Error("object_size_limit");
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  async ready() {
    await this.client.send(
      new HeadBucketCommand({ Bucket: this.config.s3Bucket }),
    );
  }
  close() {
    this.client.destroy();
  }
}
