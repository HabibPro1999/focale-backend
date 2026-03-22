import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "@config/app.config.js";
import type {
  DownloadedFile,
  StorageProvider,
  UploadOptions,
} from "./storage.provider.js";

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

  constructor() {
    // Config .refine() guarantees R2 vars exist when STORAGE_PROVIDER=r2
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.r2.accountId!}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2.accessKeyId!,
        secretAccessKey: config.r2.secretAccessKey!,
      },
    });
  }

  async upload(
    buffer: Buffer,
    key: string,
    contentType: string,
    options?: UploadOptions,
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: config.r2.bucket!,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000",
      ...(options?.contentDisposition && {
        ContentDisposition: options.contentDisposition,
      }),
    });

    await this.client.send(command);

    // Return public URL
    return `${config.r2.publicUrl}/${key}`;
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: config.r2.bucket!,
      Key: key,
    });

    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async download(key: string): Promise<DownloadedFile> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: config.r2.bucket!,
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
      Bucket: config.r2.bucket!,
      Key: key,
    });

    await this.client.send(command);
  }
}
