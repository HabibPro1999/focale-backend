export interface UploadOptions {
  contentDisposition?: string;
  cacheControl?: string;
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
   * Download a file using its storage key.
   */
  download(key: string): Promise<DownloadedFile>;

  /**
   * Delete a file from storage.
   */
  delete(key: string): Promise<void>;
}
