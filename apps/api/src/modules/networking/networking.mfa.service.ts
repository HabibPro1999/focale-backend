import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { getDb, networkingStore, networkingTransaction } from "@app/db";
import { NetworkingKeyringError } from "@app/shared";
import type { NetworkingContext } from "./networking.service";
import { networkingIdentityCache } from "../../core/networking-identity-cache";
import {
  matchNetworkingRecoveryCode,
  networkingKeys,
  networkingRecoveryCodesOutdated,
  networkingRecoveryHash,
  newNetworkingTotpSecret,
  openNetworkingSecret,
  sealNetworkingCode,
  verifyNetworkingTotp,
} from "./networking.security";
export type NetworkingMfaAction = "VERIFY" | "CONFIRM" | "DISABLE" | "REGENERATE_RECOVERY";
const newRecoveryCodes = () =>
  Array.from({ length: 10 }, () => randomBytes(8).toString("hex").toUpperCase().match(/.{4}/g)!.join("-"));
/** A sealed value whose key was retired opens as nothing: the caller treats it like a wrong code. */
function openOrNull(sealed: string) {
  try {
    return openNetworkingSecret(sealed);
  } catch (error) {
    if (error instanceof NetworkingKeyringError) return null;
    throw error;
  }
}
@Injectable()
export class NetworkingMfaService {
  async state(ctx: NetworkingContext) {
    const factor = await networkingStore(getDb()).one("secondFactors", {
      profileId: ctx.profile.id,
    });
    return {
      enabled: !!factor?.enabledAt,
      required: ctx.config.requireSecondFactor,
      verified: !!ctx.session.secondFactorVerifiedAt,
    };
  }
  async enroll(ctx: NetworkingContext) {
    return networkingTransaction(ctx.event.id, async (store) => {
      const factor = await store.one("secondFactors", {
        profileId: ctx.profile.id,
      });
      if (factor?.enabledAt)
        throw new ConflictException({ code: "NETWORKING_ACTION_NOT_ALLOWED", message: "An authenticator is already enrolled" });
      // A pending secret sealed with a retired key starts a fresh enrollment.
      const secret = (factor?.pendingEncryptedSecret && openOrNull(factor.pendingEncryptedSecret)) || newNetworkingTotpSecret();
      if (factor)
        await store.update(
          "secondFactors",
          { profileId: ctx.profile.id },
          { pendingEncryptedSecret: sealNetworkingCode(secret) },
        );
      else
        await store.insert("secondFactors", {
          profileId: ctx.profile.id,
          pendingEncryptedSecret: sealNetworkingCode(secret),
        });
      const label = encodeURIComponent(
        `Focale:${ctx.event.name}:${ctx.profile.email}`,
      );
      return {
        secret,
        otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=Focale&algorithm=SHA1&digits=6&period=30`,
      };
    });
  }
  /**
   * One MFA check. A recovery code is matched first, with the key its stored
   * hash names, so a code stays usable even if the authenticator secret can no
   * longer be opened. REGENERATE_RECOVERY replaces every recovery code after a
   * successful check; `recoveryCodesOutdated` tells the PWA to offer that when
   * remaining codes still use an older key.
   */
  async verify(
    ctx: NetworkingContext,
    code: string,
    action: NetworkingMfaAction = "VERIFY",
  ) {
    if (action === "DISABLE" && ctx.config.requireSecondFactor)
      throw new ForbiddenException({ code: "NETWORKING_MFA_ENFORCED", message: "This event requires two-factor authentication" });
    const result = await networkingTransaction(ctx.event.id, async (store) => {
      const factor = await store.one("secondFactors", {
        profileId: ctx.profile.id,
      });
      if (!factor) return { valid: false as const };
      const recent =
        factor.lastAttemptAt &&
        Date.now() - factor.lastAttemptAt.getTime() < 15 * 60_000;
      const attempts = recent ? factor.failedAttempts : 0;
      if (attempts >= 8) return { valid: false as const };
      const encrypted =
        action === "CONFIRM"
          ? factor.pendingEncryptedSecret
          : factor.encryptedSecret;
      if (!encrypted || (action === "CONFIRM" && factor.enabledAt) || (action !== "CONFIRM" && !factor.enabledAt))
        return { valid: false as const };
      const recoveryIndex =
        action !== "CONFIRM" ? matchNetworkingRecoveryCode(ctx.profile.id, code, factor.recoveryHashes) : -1;
      const secret = recoveryIndex === -1 ? openOrNull(encrypted) : null;
      const counter = secret === null ? null : verifyNetworkingTotp(secret, code, factor.lastCounter);
      if (counter === null && recoveryIndex === -1) {
        await store.update(
          "secondFactors",
          { profileId: ctx.profile.id },
          { failedAttempts: attempts + 1, lastAttemptAt: new Date() },
        );
        return { valid: false as const };
      }
      let recoveryCodes: string[] | undefined;
      let remaining: string[] = [];
      if (action === "DISABLE") {
        await store.remove("secondFactors", { profileId: ctx.profile.id });
        for (const session of await store.all("sessions", {
          profileId: ctx.profile.id,
          eventId: ctx.event.id,
        })) {
          await store.update(
            "sessions",
            {
              id: session.id,
              profileId: ctx.profile.id,
              eventId: ctx.event.id,
            },
            {
              secondFactorVerifiedAt: null,
              ...(session.id !== ctx.session.id
                ? { revokedAt: new Date() }
                : {}),
            },
          );
        }
      } else {
        remaining = [...factor.recoveryHashes];
        if (recoveryIndex >= 0) remaining.splice(recoveryIndex, 1);
        if (action === "CONFIRM" || action === "REGENERATE_RECOVERY") {
          recoveryCodes = newRecoveryCodes();
          remaining = recoveryCodes.map((value) => networkingRecoveryHash(ctx.profile.id, value));
        }
        await store.update(
          "secondFactors",
          { profileId: ctx.profile.id },
          {
            // An opened secret under an older key is resealed with the current one.
            encryptedSecret: secret !== null && !networkingKeys().isCurrent(encrypted) ? sealNetworkingCode(secret) : encrypted,
            pendingEncryptedSecret: null,
            enabledAt: factor.enabledAt ?? new Date(),
            lastCounter: counter ?? factor.lastCounter,
            failedAttempts: 0,
            lastAttemptAt: new Date(),
            recoveryHashes: remaining,
          },
        );
        await store.update(
          "sessions",
          {
            id: ctx.session.id,
            eventId: ctx.event.id,
            profileId: ctx.profile.id,
          },
          { secondFactorVerifiedAt: new Date() },
        );
      }
      await store.insert("audit", {
        eventId: ctx.event.id,
        actorId: ctx.profile.id,
        action: `MFA_${action}`,
        targetId: ctx.profile.id,
      });
      return {
        valid: true as const,
        recoveryCodes,
        recoveryCodesOutdated: action === "DISABLE" ? undefined : networkingRecoveryCodesOutdated(remaining),
      };
    });
    if (!result.valid)
      throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Invalid, reused or expired authenticator/recovery code" });
    // Disabling revoked the participant's other sessions; the current one is re-verified on its next request.
    if (action === "DISABLE") networkingIdentityCache.forgetProfile(ctx.profile.id);
    return {
      verified: true,
      ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
      ...(result.recoveryCodesOutdated === undefined ? {} : { recoveryCodesOutdated: result.recoveryCodesOutdated }),
    };
  }
}
