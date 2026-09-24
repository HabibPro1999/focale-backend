import { createHash } from "node:crypto";
import { Injectable, type ExecutionContext } from "@nestjs/common";
import { ThrottlerException, ThrottlerGuard, type ThrottlerOptions } from "@nestjs/throttler";
import {
  networkingBearerLockout,
  networkingBearerToken,
  networkingIdentityCache,
  networkingVenueKey,
} from "./networking-identity-cache";

// All throttler counters, verified identities and lockouts are in-memory and
// per process: the limits below hold only while the API runs as ONE instance.

type ThrottledRequest = {
  url?: string;
  ip?: string;
  routeOptions?: { url?: string };
  params?: { slug?: unknown };
  body?: { email?: unknown; challengeId?: unknown };
  headers?: { authorization?: unknown };
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Matched route template when routed, else the request path without its query string. */
function routePath(req: ThrottledRequest): string {
  return req.routeOptions?.url ?? req.url?.split("?")[0] ?? "";
}

/** Participant PWA routes (`/api/networking/:slug/…`); organizer `/api/events/:eventId/networking/…` routes are not. */
export function isParticipantNetworkingRequest(req: ThrottledRequest | undefined): boolean {
  return !!req && routePath(req).startsWith("/api/networking/");
}

const venue = (req: ThrottledRequest) =>
  networkingVenueKey(req.ip, typeof req.params?.slug === "string" ? req.params.slug : "");
const request = (context: ExecutionContext) => context.switchToHttp().getRequest<ThrottledRequest>();
const AUTH_ROUTE = /^\/api\/networking\/[^/]+\/auth\/(?:request|verify|mfa\/verify)$/;
// Participant routes that never read the bearer: their identity is the email/challenge or the venue.
const BEARER_AGNOSTIC_ROUTE = /^\/api\/networking\/[^/]+\/(?:config|registration|auth\/request|auth\/verify)$/;
const ORGANIZER_ROUTE = /^\/api\/events\/[^/]+\/networking(?:\/|$)/;

type BearerIdentity =
  | { kind: "none" }
  | { kind: "session"; sessionId: string }
  | { kind: "unverified"; venue: string };
const identities = new WeakMap<object, BearerIdentity>();

/**
 * How a participant request's bearer is keyed, resolved once per request:
 * `session` when the token maps to a session the service verified recently,
 * `unverified` for any other bearer, `none` without a bearer or off the
 * bearer-reading participant routes.
 */
function participantBearerIdentity(req: ThrottledRequest): BearerIdentity {
  const known = identities.get(req);
  if (known) return known;
  let identity: BearerIdentity = { kind: "none" };
  const token = networkingBearerToken(req.headers?.authorization);
  if (token && isParticipantNetworkingRequest(req) && !BEARER_AGNOSTIC_ROUTE.test(routePath(req))) {
    const sessionId = networkingIdentityCache.sessionFor(token);
    identity = sessionId ? { kind: "session", sessionId } : { kind: "unverified", venue: venue(req) };
  }
  identities.set(req, identity);
  return identity;
}

// Shared by every participant handler of one event behind one venue IP (500–2,000 attendees).
export const networkingVenueThrottler: ThrottlerOptions = {
  name: "networking-venue",
  ttl: 60_000,
  limit: 24_000,
  skipIf: (context) => !isParticipantNetworkingRequest(request(context)),
  getTracker: async (req) => venue(req as ThrottledRequest),
  generateKey: (_context, tracker) => digest(`networking-venue:${tracker}`),
};

// Sign-in endpoints per venue IP and event, alongside their per-email/per-challenge/per-session quotas.
export const networkingAuthThrottler: ThrottlerOptions = {
  name: "networking-auth",
  ttl: 60_000,
  limit: 300,
  skipIf: (context) => !AUTH_ROUTE.test(routePath(request(context))),
  getTracker: async (req) => venue(req as ThrottledRequest),
};

/**
 * Every participant bearer the service has not verified recently shares one
 * bucket per venue IP and event. Sized for cache misses at venue scale: after
 * a restart, or 5 idle minutes, each of up to 2,000 attendees behind one NAT
 * sends a few requests before its session is re-verified and cached; 12,000/min
 * (half the venue bucket, ~6 per attendee) absorbs that without 429s. Rotating
 * random bearers are stopped by the invalid-bearer lockout, and each bearer
 * keeps its own per-handler quota.
 */
export const NETWORKING_UNVERIFIED_LIMIT = 12_000;
export const networkingUnverifiedThrottler: ThrottlerOptions = {
  name: "networking-unverified",
  ttl: 60_000,
  limit: NETWORKING_UNVERIFIED_LIMIT,
  skipIf: (context) => participantBearerIdentity(request(context)).kind !== "unverified",
  getTracker: async (req) => venue(req as ThrottledRequest),
  generateKey: (_context, tracker) => digest(`networking-unverified:${tracker}`),
};

// Organizer networking routes (/api/events/:eventId/networking/**): a per-IP backstop over per-bearer quotas.
export const NETWORKING_ORGANIZER_LIMIT = 600;
export const networkingOrganizerThrottler: ThrottlerOptions = {
  name: "networking-organizer",
  ttl: 60_000,
  limit: NETWORKING_ORGANIZER_LIMIT,
  skipIf: (context) => !ORGANIZER_ROUTE.test(routePath(request(context))),
  getTracker: async (req) => (req as ThrottledRequest).ip ?? "",
  generateKey: (_context, tracker) => digest(`networking-organizer:${tracker}`),
};

/** Throttlers registered ahead of the global default (see CoreModule). */
export const networkingThrottlers: ThrottlerOptions[] = [
  networkingVenueThrottler,
  networkingAuthThrottler,
  networkingUnverifiedThrottler,
  networkingOrganizerThrottler,
];

@Injectable()
export class NetworkingThrottlerGuard extends ThrottlerGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = request(context);
    const identity = participantBearerIdentity(req);
    // Invalid-bearer lockout: blocks unverified bearers only; sign-in routes keep their own limits.
    if (identity.kind === "unverified" && !AUTH_ROUTE.test(routePath(req))) {
      const lockedMs = networkingBearerLockout.lockedFor(identity.venue);
      if (lockedMs > 0) {
        const reply = context.switchToHttp().getResponse<{ header?: (name: string, value: number) => unknown }>();
        reply.header?.("Retry-After", Math.ceil(lockedMs / 1000));
        throw new ThrottlerException();
      }
    }
    return super.canActivate(context);
  }

  protected override async getTracker(req: ThrottledRequest): Promise<string> {
    const path = routePath(req);
    // Participant and organizer networking routes key identities; other modules keep per-IP limits.
    if (!/^\/api\/(?:networking\/|events\/[^/]+\/networking(?:\/|$))/.test(path)) return super.getTracker(req);
    const slug = typeof req.params?.slug === "string" ? req.params.slug : "";
    // Auth identity takes precedence over any supplied bearer header.
    if (path.endsWith("/auth/request")) {
      const email = req.body?.email;
      if (typeof email === "string" && email.trim())
        return digest(`otp:${slug}:${email.trim().toLowerCase()}`);
      return super.getTracker(req);
    }
    if (path.endsWith("/auth/verify")) {
      const challengeId = req.body?.challengeId;
      // Verify has no email in its contract. The service also caps attempts per challenge and per email.
      if (typeof challengeId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challengeId))
        return digest(`verify:${slug}:${challengeId.toLowerCase()}`);
      return super.getTracker(req);
    }
    // A verified participant session gets its own quota. Any other bearer (unverified participant
    // tokens, organizer ID tokens) keeps a per-token quota in a separate namespace, so presenting
    // a session id as a bearer can never draw on that session's bucket.
    const identity = participantBearerIdentity(req);
    if (identity.kind === "session") return digest(`session:${identity.sessionId}`);
    const token = networkingBearerToken(req.headers?.authorization);
    return token ? digest(`bearer:${token}`) : super.getTracker(req);
  }
}
