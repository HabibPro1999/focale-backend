/**
 * Simple in-memory cache with TTL support.
 * Useful for caching frequently accessed data like user lookups.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class SimpleCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private sweepTimer: ReturnType<typeof setInterval>;

  /**
   * Create a new cache with a specified TTL.
   * @param ttlSeconds - Time-to-live in seconds
   * @param maxSize - Maximum number of entries before eviction (default 1000)
   * @param sweepIntervalMs - Interval in ms for periodic expiry sweep (default 60000)
   */
  constructor(
    ttlSeconds: number,
    maxSize: number = 1000,
    sweepIntervalMs: number = 60_000,
  ) {
    this.ttlMs = ttlSeconds * 1000;
    this.maxSize = maxSize;
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref();
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

    if (this.cache.size > this.maxSize) {
      this.sweep();

      if (this.cache.size > this.maxSize) {
        // Evict the entry with the smallest expiresAt (oldest-expiring)
        let oldestKey: string | undefined;
        let oldestExpiry = Infinity;
        for (const [k, entry] of this.cache) {
          if (entry.expiresAt < oldestExpiry) {
            oldestExpiry = entry.expiresAt;
            oldestKey = k;
          }
        }
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }
    }
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

  /**
   * Remove all expired entries from the cache.
   */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Stop the sweep timer. Call when the cache is no longer needed.
   */
  dispose(): void {
    clearInterval(this.sweepTimer);
  }
}
