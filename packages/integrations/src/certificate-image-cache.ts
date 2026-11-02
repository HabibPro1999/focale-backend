// =============================================================================
// CERTIFICATE IMAGE CACHE (3.8)
// One cache per process for the template image bytes certificate rendering
// embeds, bounded by total bytes, least recently used entry evicted first. It
// replaces the Map each email-queue run used to create. Entries are keyed by
// storage key; a key is never overwritten (every upload writes fresh keys, and
// the backfill a fresh render key), so a cached entry never goes stale.
// =============================================================================

import { getStorageProvider } from "./storage/index";

/** Buffers by key, bounded by their total byte length (LRU eviction). */
export class ByteLruCache {
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new RangeError("ByteLruCache maxBytes must be a positive number");
    }
  }

  /** Bytes currently held. */
  get totalBytes(): number {
    return this.bytes;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The cached buffer, now the most recently used; undefined on a miss. */
  get(key: string): Buffer | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Map keeps insertion order: re-inserting moves the key to the end.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /**
   * Store `value` as the most recently used entry, evicting the least
   * recently used ones until the total fits. A buffer larger than the whole
   * cache is not stored (false); any older entry for the key is dropped.
   */
  set(key: string, value: Buffer): boolean {
    this.delete(key);
    if (value.byteLength > this.maxBytes) return false;
    this.entries.set(key, value);
    this.bytes += value.byteLength;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldestKey);
      this.bytes -= oldest.byteLength;
    }
    return true;
  }

  delete(key: string): boolean {
    const value = this.entries.get(key);
    if (value === undefined) return false;
    this.entries.delete(key);
    this.bytes -= value.byteLength;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

/** Capacity of the process-wide certificate image cache. */
export const CERTIFICATE_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** The process-wide cache: every certificate render in this process shares it. */
export const certificateImageCache = new ByteLruCache(CERTIFICATE_IMAGE_CACHE_MAX_BYTES);

// Downloads in progress, so parallel renders of one template on a cold cache
// fetch the object once.
const inFlight = new Map<string, Promise<Buffer>>();

/**
 * Bytes of the stored object `key`: from the cache, or downloaded once (a
 * download already in progress for the key is shared) and cached. Storage
 * errors (StorageObjectNotFoundError included) reach the caller and nothing
 * is cached.
 */
export function loadCertificateImage(key: string): Promise<Buffer> {
  const cached = certificateImageCache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const download = (async () => {
    try {
      const file = await getStorageProvider().download(key);
      certificateImageCache.set(key, file.buffer);
      return file.buffer;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, download);
  return download;
}
