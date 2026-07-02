import {
  getUserIdsByClient,
  type ClientRow,
  type UserRow,
} from "@app/db";
import { UserRole } from "@app/contracts";

/** The explicit 8-field user shape attached to request.user (no client relation). */
export type AuthUser = Pick<
  UserRow,
  | "id"
  | "email"
  | "name"
  | "role"
  | "clientId"
  | "active"
  | "createdAt"
  | "updatedAt"
>;

export type CachedAuthUser = { user: AuthUser; client: ClientRow | null };

// ---------------------------------------------------------------------------
// SimpleCache (ported from src/shared/utils/cache.ts): TTL + soonest-expiry
// eviction over maxSize + periodic unref'd sweep.
// ---------------------------------------------------------------------------
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class SimpleCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    ttlSeconds: number,
    maxSize = 1000,
    sweepIntervalMs = 60_000,
  ) {
    this.ttlMs = ttlSeconds * 1000;
    this.maxSize = maxSize;
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });

    if (this.cache.size > this.maxSize) {
      this.sweep();
      if (this.cache.size > this.maxSize) {
        // Evict the entry with the smallest expiresAt (soonest-expiring).
        let oldestKey: string | undefined;
        let oldestExpiry = Infinity;
        for (const [k, entry] of this.cache) {
          if (entry.expiresAt < oldestExpiry) {
            oldestExpiry = entry.expiresAt;
            oldestKey = k;
          }
        }
        if (oldestKey !== undefined) this.cache.delete(oldestKey);
      }
    }
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }
}

// Module-level singleton, keyed by Firebase UID (== User.id). 60s TTL.
export const userCache = new SimpleCache<CachedAuthUser>(60);

/** Invalidate a user's cache entry (call after any user mutation). */
export function invalidateUserCache(userId: string): void {
  userCache.invalidate(userId);
}

/**
 * Invalidate all cached users for a client — call when the client's `active`
 * flag flips so tenant-active status propagates without waiting out the TTL.
 */
export async function invalidateUserCacheForClient(
  clientId: string,
): Promise<void> {
  const ids = await getUserIdsByClient(clientId);
  for (const id of ids) userCache.invalidate(id);
}

/** Test-only: wipe the whole cache. */
export function clearUserCache(): void {
  userCache.clear();
}

/**
 * Whether a user can access a client's resources. Super admins: always.
 * Client admins: only their own client. Any other role: denied (fail-closed).
 */
export function canAccessClient(
  user: { role: number; clientId: string | null },
  clientId: string,
): boolean {
  if (user.role === UserRole.SUPER_ADMIN) return true;
  if (user.role === UserRole.CLIENT_ADMIN) return user.clientId === clientId;
  return false;
}
