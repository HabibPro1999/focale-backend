import { createHash } from "node:crypto";

// In-process state shared by the networking throttler guard (reads) and the
// networking service (writes). Like the throttler storage, it lives in memory,
// which is correct only while the API runs as ONE instance (plan decision); a
// second replica would see neither the verified identities nor the lockouts
// recorded by the other.

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The credential of an `Authorization: Bearer <token>` header, if any (not format-checked). */
export function networkingBearerToken(authorization: unknown): string | undefined {
  return typeof authorization === "string"
    ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1]
    : undefined;
}

/** One venue: a client IP within one event slug (the guard's venue bucket key). */
export function networkingVenueKey(ip: string | undefined, slug: string): string {
  return `${ip ?? ""}:${slug}`;
}

type VerifiedIdentity = { sessionId: string; profileId: string; expiresAt: number };

export const NETWORKING_IDENTITY_TTL_MS = 5 * 60_000;
export const NETWORKING_IDENTITY_MAX_ENTRIES = 20_000;

/**
 * Bounded LRU of sha256(bearer token) → verified participant session. Filled
 * only after the service has verified the session against the database, so a
 * random bearer can never claim a verified throttle identity. Entries last at
 * most 5 minutes (never past the session's own expiry); revocation paths in
 * the API evict eagerly, and the TTL bounds staleness for the rest (worker
 * processes, registration sync, cascading deletes).
 */
export class NetworkingIdentityCache {
  private readonly entries = new Map<string, VerifiedIdentity>();

  constructor(
    private readonly maxEntries = NETWORKING_IDENTITY_MAX_ENTRIES,
    private readonly ttlMs = NETWORKING_IDENTITY_TTL_MS,
  ) {}

  /** The verified session id for this bearer token, or undefined. */
  sessionFor(token: string): string | undefined {
    const key = sha256(token);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.sessionId;
  }

  remember(token: string, session: { id: string; profileId: string; expiresAt: Date }): void {
    const now = Date.now();
    const expiresAt = Math.min(now + this.ttlMs, session.expiresAt.getTime());
    const key = sha256(token);
    this.entries.delete(key);
    if (!(expiresAt > now)) return;
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { sessionId: session.id, profileId: session.profileId, expiresAt });
  }

  forgetToken(token: string): void {
    this.entries.delete(sha256(token));
  }

  forgetSession(sessionId: string): void {
    this.forgetWhere((entry) => entry.sessionId === sessionId);
  }

  /** Every session of a participant, e.g. after revokeNetworkingSessions(profileId). */
  forgetProfile(profileId: string): void {
    this.forgetWhere((entry) => entry.profileId === profileId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private forgetWhere(match: (entry: VerifiedIdentity) => boolean): void {
    for (const [key, entry] of this.entries) if (match(entry)) this.entries.delete(key);
  }
}

/**
 * Lockout sizing (one venue = one IP + event slug; venues put 500–2,000
 * attendees behind one NAT IP):
 * - Only bearers the participant service actually rejected count (missing,
 *   malformed, unknown, revoked or expired sessions). Eligibility, consent and
 *   MFA refusals are valid sessions and never count.
 * - Counting is by distinct token: a stale token that the PWA retries counts
 *   once. 200 distinct rejected bearers within 10 minutes (10% of the largest
 *   venue) trips the lockout; a handful of stale tokens, or even a mass
 *   revocation of a couple of hundred attendees, stays below it, while a spray
 *   of rotating random bearers trips it after 200 requests.
 * - The lockout lasts 10 minutes and only blocks unverified bearer requests
 *   for that venue; verified sessions and the sign-in routes are unaffected.
 */
export const NETWORKING_BEARER_LOCKOUT = {
  threshold: 200,
  windowMs: 10 * 60_000,
  durationMs: 10 * 60_000,
  /** Recently rejected token digests remembered per venue for de-duplication. */
  recentTokens: 64,
  maxVenues: 10_000,
} as const;

export type NetworkingBearerLockoutOptions = {
  readonly threshold: number;
  readonly windowMs: number;
  readonly durationMs: number;
  readonly recentTokens: number;
  readonly maxVenues: number;
};

type VenueRejections = {
  windowStart: number;
  count: number;
  recent: Set<string>;
  lockedUntil: number;
};

export class NetworkingBearerLockout {
  private readonly venues = new Map<string, VenueRejections>();

  constructor(private readonly options: NetworkingBearerLockoutOptions = NETWORKING_BEARER_LOCKOUT) {}

  /** Record a bearer the participant service rejected for this venue. */
  recordRejected(venue: string, token: string): void {
    const now = Date.now();
    let state = this.venues.get(venue);
    if (state) this.venues.delete(venue);
    else state = { windowStart: now, count: 0, recent: new Set(), lockedUntil: 0 };
    if (now - state.windowStart >= this.options.windowMs) {
      state.windowStart = now;
      state.count = 0;
      state.recent.clear();
    }
    const digest = sha256(token).slice(0, 32);
    if (!state.recent.has(digest)) {
      state.recent.add(digest);
      if (state.recent.size > this.options.recentTokens) {
        const oldest = state.recent.values().next().value;
        if (oldest !== undefined) state.recent.delete(oldest);
      }
      state.count += 1;
      if (state.count >= this.options.threshold) {
        state.lockedUntil = now + this.options.durationMs;
        state.windowStart = now;
        state.count = 0;
        state.recent.clear();
      }
    }
    while (this.venues.size >= this.options.maxVenues) {
      const oldest = this.venues.keys().next().value;
      if (oldest === undefined) break;
      this.venues.delete(oldest);
    }
    this.venues.set(venue, state);
  }

  /** Milliseconds left on this venue's lockout, or 0. */
  lockedFor(venue: string): number {
    const state = this.venues.get(venue);
    return state ? Math.max(0, state.lockedUntil - Date.now()) : 0;
  }

  clear(): void {
    this.venues.clear();
  }
}

export const networkingIdentityCache = new NetworkingIdentityCache();
export const networkingBearerLockout = new NetworkingBearerLockout();
