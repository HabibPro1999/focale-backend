import { getFirebaseStorage } from "../firebase";
import {
  StorageObjectNotFoundError,
  storageListLimit,
  type DownloadedFile,
  type StorageListPage,
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

  async list(prefix: string, options: { cursor?: string; limit?: number } = {}): Promise<StorageListPage> {
    const bucket = getFirebaseStorage().bucket();
    // One page per call: autoPaginate off, the page token is the cursor.
    const [files, nextQuery] = await bucket.getFiles({
      prefix,
      autoPaginate: false,
      maxResults: storageListLimit(options.limit),
      ...(options.cursor ? { pageToken: options.cursor } : {}),
    });
    const pageToken = (nextQuery as { pageToken?: unknown } | null | undefined)?.pageToken;
    return {
      items: files.map((file) => {
        const { updated, size } = file.metadata ?? {};
        const updatedAt = updated ? new Date(updated) : null;
        const bytes = size === undefined || size === null ? null : Number(size);
        return {
          key: file.name,
          updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
          size: bytes !== null && Number.isFinite(bytes) ? bytes : null,
        };
      }),
      nextCursor: typeof pageToken === "string" && pageToken ? pageToken : null,
    };
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
