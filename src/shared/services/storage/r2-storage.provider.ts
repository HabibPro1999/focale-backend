import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "@config/app.config.js";
import type { StorageProvider } from "./storage.provider.js";

export class R2StorageProvider implements StorageProvider {
  private client: S3Client;

  constructor() {
    // Runtime guard: verify R2 config is present
    if (
      !config.r2.accountId ||
      !config.r2.accessKeyId ||
      !config.r2.secretAccessKey ||
      !config.r2.bucket
    ) {
      throw new Error(
        "R2 configuration missing. Ensure R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET are set.",
      );
    }

    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
      },
    });
  }

  async upload(
    buffer: Buffer,
    key: string,
    contentType: string,
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: config.r2.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000",
    });

    await this.client.send(command);

    // Return public URL
    return `${config.r2.publicUrl}/${key}`;
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: config.r2.bucket,
      Key: key,
    });

    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: config.r2.bucket,
      Key: key,
    });

    await this.client.send(command);
  }
}
