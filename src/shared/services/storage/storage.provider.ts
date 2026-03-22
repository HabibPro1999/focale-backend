export interface UploadOptions {
  contentDisposition?: string;
}

export interface DownloadedFile {
  buffer: Buffer;
  contentType: string | null;
}

/**
 * Storage provider interface for file uploads.
 * Supports multiple backends (Firebase, R2).
 */
export interface StorageProvider {
  /**
   * Upload a file and return its public URL.
   */
  upload(
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
