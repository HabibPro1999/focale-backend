import { ErrorCodes } from "@app/contracts";
import { IntegrationError } from "../errors";

export interface UploadOptions {
  contentDisposition?: string;
  cacheControl?: string;
}

/**
 * The object does not exist, whichever provider stores it (Firebase 404 or R2
 * NoSuchKey). An IntegrationError, so one that escapes a caller still maps to
 * 404 NOT_FOUND instead of a 500. The key stays on the error for logs only.
 */
export class StorageObjectNotFoundError extends IntegrationError {
  constructor(public readonly key: string) {
    super("Stored file not found", 404, ErrorCodes.NOT_FOUND);
  }
}

export interface DownloadedFile {
  buffer: Buffer;
  contentType: string | null;
}

/**
 * Storage provider interface for file uploads.
 * Public uploads return a URL. Private uploads return the storage key.
 */
export interface StorageProvider {
  uploadPublic(
    buffer: Buffer,
    key: string,
    contentType: string,
    options?: UploadOptions,
  ): Promise<string>;

  uploadPrivate(
    buffer: Buffer,
    key: string,
    contentType: string,
    options?: UploadOptions,
  ): Promise<string>;

  /**
   * Generate a temporary signed URL for private file access.
   */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;

  /**
   * Download a file using its storage key. Throws StorageObjectNotFoundError
   * when no object has that key.
   */
  download(key: string): Promise<DownloadedFile>;

  /**
   * Delete a file from storage.
   */
  delete(key: string): Promise<void>;
}
