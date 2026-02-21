/**
 * Simple in-memory cache with TTL support.
 * Useful for caching frequently accessed data like user lookups.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory TTL cache with lazy expiry.
 *
 * Expiry semantics:
 * - Expired entries are removed only on access (`get`), not on a background schedule.
 * - `size` counts all entries including expired ones that have not been accessed yet.
 * - Memory grows unbounded if keys are written but never read again; call `clear()`
 *   periodically or bound the number of distinct keys if unbounded growth is a concern.
 */
export class SimpleCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  /**
   * Create a new cache with a specified TTL.
   * @param ttlSeconds - Time-to-live in seconds
   */
  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000;
  }

  /**
   * Get a value from the cache.
   * Returns undefined if not found or expired.
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Set a value in the cache.
   */
  set(key: string, value: T): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Invalidate a specific key.
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of entries in the cache.
   * Note: May include expired entries that haven't been cleaned up yet.
   */
  get size(): number {
    return this.cache.size;
  }
}
