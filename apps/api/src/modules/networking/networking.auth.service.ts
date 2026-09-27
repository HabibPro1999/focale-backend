import {
  networkingSessionExpired as expired,
  networkingBearer as bearer,
} from "./networking.session-policy";

import { HttpException, HttpStatus, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes, randomInt } from "node:crypto";
import {
  enqueueNetworkingDelivery,
  networkingStore,
  networkingTransaction,
  type NetworkingStore,
} from "@app/db";
import { ErrorCodes, type NetworkingConfig } from "@app/contracts";
import { networkingIdentityCache } from "../../core/networking-identity-cache";
import { networkingHash, sealNetworkingCode } from "./networking.security";

import { NetworkingService } from "./networking.service";

const OTP_FAILED_ATTEMPT_LIMITS = { recent: { windowMs: 15 * 60_000, max: 10 }, daily: { windowMs: 86_400_000, max: 30 } } as const;
const otpRateLimited = () => new HttpException({ code: ErrorCodes.NETWORKING_RATE_LIMITED, message: "Too many verification attempts" }, HttpStatus.TOO_MANY_REQUESTS);

@Injectable()
export class NetworkingAuthService {
  constructor(private readonly networking: NetworkingService) {}
  async logout(slug: string, authorization?: string) {
    const token = bearer(authorization);
    if (!token) throw expired("Participant session required");
    networkingIdentityCache.forgetToken(token);
    const store = networkingStore();
    const event = await store.one("events", { slug });
    if (event)
      await store.update(
        "sessions",
        { eventId: event.id, tokenHash: networkingHash(token), revokedAt: null },
        { revokedAt: new Date() },
      );
    return { loggedOut: true };
  }
  async requestCode(slug: string, email: string) {
    email = email.trim().toLowerCase();
    const { event, config } = await this.networking.publicContext(slug);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = networkingHash(`otp:${event.id}:${email}:${code}`);
    // The event/config gate ran just above; the transaction only touches rows keyed by this email.
    return networkingTransaction(event.id, async (store, db) => {
      const recent = (
        await store.all("challenges", { eventId: event.id, email })
      ).filter((v) => Date.now() - v.createdAt.getTime() < 15 * 60_000);
      // Same generic response for throttled, unapproved and unknown email addresses.
      const challengeId = crypto.randomUUID();
      if (recent.length >= 5) return { challengeId };
      await store.update(
        "challenges",
        { eventId: event.id, email, consumedAt: null },
        { consumedAt: new Date() },
      );
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      await store.insert("challenges", {
        id: challengeId,
        eventId: event.id,
        email,
        codeHash,
        expiresAt,
      });
      const profile = await this.firstAccessibleProfile(event.id, email, config, store);
      if (profile)
        await enqueueNetworkingDelivery(
          {
            eventId: event.id,
            profileId: profile.id,
            email,
            type: "OTP",
            payload: {
              encryptedCode: sealNetworkingCode(code),
              challengeId,
              expiresAt: expiresAt.toISOString(),
              eventName: event.name,
              slug,
            },
            dedupeKey: `otp:${challengeId}`,
          },
          db,
        );
      return { challengeId };
    });
  }
  async verifyCode(slug: string, challengeId: string, code: string) {
    const { event, config } = await this.networking.publicContext(slug);
    const result = await networkingTransaction(event.id, async (store) => {
      const challenge = await store.one("challenges", {
        id: challengeId,
        eventId: event.id,
      });
      if (
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= Date.now() ||
        challenge.attempts >= 5
      )
        return null;
      // Checked before the code is compared, so a limited address learns nothing about it.
      // SERIALIZABLE makes concurrent attempts on this email's challenges commit one at a time.
      const now = Date.now();
      const failed = await store.failedOtpAttempts(
        event.id,
        challenge.email,
        new Date(now - OTP_FAILED_ATTEMPT_LIMITS.recent.windowMs),
        new Date(now - OTP_FAILED_ATTEMPT_LIMITS.daily.windowMs),
      );
      if (
        failed.recent >= OTP_FAILED_ATTEMPT_LIMITS.recent.max ||
        failed.daily >= OTP_FAILED_ATTEMPT_LIMITS.daily.max
      )
        return "rate-limited" as const;
      const valid =
        challenge.codeHash ===
        networkingHash(`otp:${event.id}:${challenge.email}:${code}`);
      await store.update(
        "challenges",
        { id: challenge.id, eventId: event.id },
        {
          attempts: challenge.attempts + 1,
          ...(valid ? { consumedAt: new Date(), verifiedAt: new Date() } : {}),
        },
      );
      if (!valid) return null;
      const profile = await this.firstAccessibleProfile(event.id, challenge.email, config, store);
      if (profile) {
        const token = randomBytes(48).toString("base64url");
        const expiresAt = new Date(Date.now() + 30 * 86_400_000);
        const session = await store.insert("sessions", {
          eventId: event.id,
          profileId: profile.id,
          tokenHash: networkingHash(token),
          expiresAt,
        });
        const factor = await store.one("secondFactors", {
          profileId: profile.id,
        });
        return {
          session,
          token,
          expiresAt,
          profile,
          requiresSecondFactor:
            config.requireSecondFactor || !!factor?.enabledAt,
          mfaEnrollmentRequired:
            config.requireSecondFactor && !factor?.enabledAt,
        };
      }
      return null;
    });
    if (result === "rate-limited") throw otpRateLimited();
    // Stays 401 (no session issued); NETWORKING_VALIDATION is reserved for HTTP 400.
    if (!result)
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: "Invalid or expired verification code" });
    const { session, ...issued } = result;
    // Committed and verified: the new bearer is throttled as its session from the first request.
    networkingIdentityCache.remember(issued.token, session);
    return issued;
  }
  private async firstAccessibleProfile(eventId: string, email: string, config: NetworkingConfig, store: NetworkingStore) {
    const profiles = await store.all("profiles", { eventId, email });
    profiles.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    for (const profile of profiles) {
      if (await this.networking.access(profile, config, store)) return profile;
    }
    return undefined;
  }
}
