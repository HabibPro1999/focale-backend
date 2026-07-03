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

/**
 * Extract a storage key from a stored file URL. Handles bare keys (no "://"),
 * Firebase (storage.googleapis.com → strip the bucket segment), and
 * R2/custom-domain URLs (strip the leading "/"). Returns null on parse failure.
 */
export function extractStorageKeyFromUrl(url: string): string | null {
  if (!url.includes("://")) {
    return url || null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "storage.googleapis.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      return decodeURIComponent(parts.slice(1).join("/"));
    }
    return decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
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
