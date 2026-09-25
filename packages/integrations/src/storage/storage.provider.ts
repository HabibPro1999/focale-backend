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

/** One stored object, as a listing reports it. */
export interface StoredObject {
  key: string;
  /** Last write time; null when the provider does not report one. */
  updatedAt: Date | null;
  size: number | null;
}

export interface StorageListPage {
  items: StoredObject[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

/** Most keys a single list call returns (both providers cap a page at 1,000). */
export const STORAGE_LIST_MAX_LIMIT = 1000;

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

  /**
   * One page of the objects whose key starts with `prefix`, in key order.
   * `limit` is clamped to 1..STORAGE_LIST_MAX_LIMIT (default the maximum).
   */
  list(prefix: string, options?: { cursor?: string; limit?: number }): Promise<StorageListPage>;
}

/** The page size a list call asks the provider for. */
export function storageListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return STORAGE_LIST_MAX_LIMIT;
  return Math.min(STORAGE_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}
