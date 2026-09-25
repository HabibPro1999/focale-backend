import { getFirebaseStorage } from "../firebase";
import {
  StorageObjectNotFoundError,
  type DownloadedFile,
  type StorageProvider,
  type UploadOptions,
} from "./storage.provider";

export class FirebaseStorageProvider implements StorageProvider {
  async uploadPublic(
    buffer: Buffer,
    key: string,
    contentType: string,
    options?: UploadOptions,
  ): Promise<string> {
    const file = await this.save(buffer, key, contentType, {
      ...options,
      cacheControl: options?.cacheControl ?? "public, max-age=31536000",
    });
    await file.makePublic();
    return file.publicUrl();
  }

  async uploadPrivate(
    buffer: Buffer,
    key: string,
    contentType: string,
    options?: UploadOptions,
  ): Promise<string> {
    await this.save(buffer, key, contentType, {
      ...options,
      cacheControl: options?.cacheControl ?? "private, max-age=0",
    });
    return key;
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const bucket = getFirebaseStorage().bucket();
    const file = bucket.file(key);

    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + expiresInSeconds * 1000,
    });

    return url;
  }

  async download(key: string): Promise<DownloadedFile> {
    const bucket = getFirebaseStorage().bucket();
    const file = bucket.file(key);

    try {
      const [buffer] = await file.download();
      const [metadata] = await file.getMetadata();
      return {
        buffer,
        contentType: metadata.contentType ?? null,
      };
    } catch (err) {
      if ((err as { code?: unknown }).code === 404) {
        throw new StorageObjectNotFoundError(key);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const bucket = getFirebaseStorage().bucket();
    const file = bucket.file(key);

    await file.delete({ ignoreNotFound: true });
  }

  private async save(
    buffer: Buffer,
    key: string,
    contentType: string,
    options?: UploadOptions,
  ) {
    const bucket = getFirebaseStorage().bucket();
    const file = bucket.file(key);

    await file.save(buffer, {
      contentType,
      metadata: {
        cacheControl: options?.cacheControl,
        ...(options?.contentDisposition && {
          contentDisposition: options.contentDisposition,
        }),
      },
    });

    return file;
  }
}
