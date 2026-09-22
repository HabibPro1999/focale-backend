import { createHash } from "node:crypto";
import { Injectable, type ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerOptions } from "@nestjs/throttler";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function networkingPath(req: { url?: string }): string | undefined {
  const path = req.url?.split("?")[0];
  return path && /\/networking(?:\/|$)/.test(path) ? path : undefined;
}

// Shared across networking handlers and identities; checked before identity quotas.
export const networkingIpThrottler: ThrottlerOptions = {
  name: "networking-ip",
  ttl: 60_000,
  limit: 600,
  skipIf: (context: ExecutionContext) => !networkingPath(context.switchToHttp().getRequest()),
  getTracker: async (req) => req.ip,
  generateKey: (_context, tracker) => digest(`networking-ip:${tracker}`),
};

@Injectable()
export class NetworkingThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: { url?: string; ip?: string; params?: { slug?: unknown }; body?: { email?: unknown; challengeId?: unknown }; headers?: { authorization?: unknown } }): Promise<string> {
    const path = networkingPath(req);
    if (!path) return super.getTracker(req);
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
    const authorization = req.headers?.authorization;
    const token = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] : undefined;
    return token ? digest(`session:${token}`) : super.getTracker(req);
  }
}
