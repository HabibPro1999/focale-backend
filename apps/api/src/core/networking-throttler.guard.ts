import { createHash } from "node:crypto";
import { Injectable, type ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerOptions } from "@nestjs/throttler";

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
  `${req.ip ?? ""}:${typeof req.params?.slug === "string" ? req.params.slug : ""}`;
const request = (context: ExecutionContext) => context.switchToHttp().getRequest<ThrottledRequest>();
const AUTH_ROUTE = /^\/api\/networking\/[^/]+\/auth\/(?:request|verify|mfa\/verify)$/;

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

@Injectable()
export class NetworkingThrottlerGuard extends ThrottlerGuard {
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
      // Verify has no email in its contract. The service also caps attempts per challenge.
      if (typeof challengeId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challengeId))
        return digest(`verify:${slug}:${challengeId.toLowerCase()}`);
      return super.getTracker(req);
    }
    // Bearer sessions (participant or organizer badge scanning) get their own quota.
    const authorization = req.headers?.authorization;
    const token = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] : undefined;
    return token ? digest(`session:${token}`) : super.getTracker(req);
  }
}
