import { firebaseStorage } from "../firebase.service.js";
import type {
  DownloadedFile,
  StorageProvider,
  UploadOptions,
} from "./storage.provider.js";

export class FirebaseStorageProvider implements StorageProvider {
  async upload(
    buffer: Buffer,
    key: string,
    contentType: string,
    options?: UploadOptions,
  ): Promise<string> {
    const bucket = firebaseStorage.bucket();
    const file = bucket.file(key);

    await file.save(buffer, {
      contentType,
      metadata: {
        cacheControl: "public, max-age=31536000",
        ...(options?.contentDisposition && {
          contentDisposition: options.contentDisposition,
        }),
      },
    });

    await file.makePublic();
    return file.publicUrl();
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const bucket = firebaseStorage.bucket();
    const file = bucket.file(key);

    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + expiresInSeconds * 1000,
    });

    return url;
  }

  async download(key: string): Promise<DownloadedFile> {
    const bucket = firebaseStorage.bucket();
    const file = bucket.file(key);

    const [buffer] = await file.download();
    const [metadata] = await file.getMetadata();

    return {
      buffer,
      contentType: metadata.contentType ?? null,
    };
  }

  async delete(key: string): Promise<void> {
    const bucket = firebaseStorage.bucket();
    const file = bucket.file(key);

    await file.delete({ ignoreNotFound: true });
  }
}
