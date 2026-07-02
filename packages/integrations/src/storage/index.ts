import { FirebaseStorageProvider } from "./firebase-storage.provider";
import { R2StorageProvider } from "./r2-storage.provider";
import type { StorageProvider } from "./storage.provider";

let instance: StorageProvider | null = null;

/**
 * Get the configured storage provider singleton.
 * Returns R2 when STORAGE_PROVIDER=r2, Firebase otherwise. Memoized on first call.
 */
export function getStorageProvider(): StorageProvider {
  if (!instance) {
    instance =
      process.env.STORAGE_PROVIDER === "r2"
        ? new R2StorageProvider()
        : new FirebaseStorageProvider();
  }
  return instance;
}

export { FirebaseStorageProvider } from "./firebase-storage.provider";
export { R2StorageProvider } from "./r2-storage.provider";
export {
  compressFile,
  compressImage,
  type CompressedFile,
} from "./compress";
export type {
  DownloadedFile,
  StorageProvider,
  UploadOptions,
} from "./storage.provider";
