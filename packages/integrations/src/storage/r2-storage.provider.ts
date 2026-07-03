import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  DownloadedFile,
  StorageProvider,
  UploadOptions,
} from "./storage.provider";

async function readBodyAsBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    return Buffer.from(await body.transformToByteArray());
  }

  if (
    typeof body === "object" &&
    body !== null &&
    Symbol.asyncIterator in body
  ) {
    const chunks: Uint8Array[] = [];

    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
      );
    }

    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported R2 response body");
}

export class R2StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private publicUrl: string;

  constructor() {
    // App config .refine() guarantees these R2 vars exist when STORAGE_PROVIDER=r2.
    this.bucket = process.env.R2_BUCKET!;
    this.publicUrl = process.env.R2_PUBLIC_URL!;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID!}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }

  async uploadPublic(
    buffer: Buffer,
    key: string,
    contentType: string,
    options?: UploadOptions,
  ): Promise<string> {
    await this.putObject(buffer, key, contentType, {
      ...options,
      cacheControl: options?.cacheControl ?? "public, max-age=31536000",
    });

    return `${this.publicUrl.replace(/\/$/, "")}/${key}`;
  }

  async uploadPrivate(
    buffer: Buffer,
    key: string,
    contentType: string,
    options?: UploadOptions,
  ): Promise<string> {
    await this.putObject(buffer, key, contentType, {
      ...options,
      cacheControl: options?.cacheControl ?? "private, max-age=0",
    });
    return key;
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async download(key: string): Promise<DownloadedFile> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    return {
      buffer: await readBodyAsBuffer(response.Body),
      contentType: response.ContentType ?? null,
    };
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    await this.client.send(command);
  }

  private async putObject(
    buffer: Buffer,
    key: string,
    contentType: string,
    options?: UploadOptions,
  ): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: options?.cacheControl,
      ...(options?.contentDisposition && {
        ContentDisposition: options.contentDisposition,
      }),
    });

    await this.client.send(command);
  }
}
