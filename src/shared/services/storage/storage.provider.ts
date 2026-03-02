export interface UploadOptions {
  contentDisposition?: string;
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
   * Delete a file from storage.
   */
  delete(key: string): Promise<void>;
}
