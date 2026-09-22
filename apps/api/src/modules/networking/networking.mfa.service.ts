import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { networkingStore, networkingTransaction } from "@app/db";
import type { NetworkingContext } from "./networking.service";
import {
  newNetworkingTotpSecret,
  networkingHash,
  openNetworkingSecret,
  sealNetworkingCode,
  verifyNetworkingTotp,
} from "./networking.security";
@Injectable()
export class NetworkingMfaService {
  async state(ctx: NetworkingContext) {
    const factor = await networkingStore().one("secondFactors", {
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
        throw new ConflictException({ code: "NETWORKING_VALIDATION", message: "An authenticator is already enrolled" });
      const secret = factor?.pendingEncryptedSecret
        ? openNetworkingSecret(factor.pendingEncryptedSecret)
        : newNetworkingTotpSecret();
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
  async verify(
    ctx: NetworkingContext,
    code: string,
    action: "VERIFY" | "CONFIRM" | "DISABLE" = "VERIFY",
  ) {
    if (action === "DISABLE" && ctx.config.requireSecondFactor)
      throw new ForbiddenException({ code: "NETWORKING_MFA_REQUIRED", message: "This event requires two-factor authentication" });
    const result = await networkingTransaction(ctx.event.id, async (store) => {
      const factor = await store.one("secondFactors", {
        profileId: ctx.profile.id,
      });
      if (!factor) return { valid: false };
      const recent =
        factor.lastAttemptAt &&
        Date.now() - factor.lastAttemptAt.getTime() < 15 * 60_000;
      const attempts = recent ? factor.failedAttempts : 0;
      if (attempts >= 8) return { valid: false };
      const encrypted =
        action === "CONFIRM"
          ? factor.pendingEncryptedSecret
          : factor.encryptedSecret;
      if (!encrypted || (action === "CONFIRM" && factor.enabledAt))
        return { valid: false };
      const counter = verifyNetworkingTotp(
        openNetworkingSecret(encrypted),
        code,
        factor.lastCounter,
      );
      const recoveryHash = networkingHash(
        `recovery:${ctx.profile.id}:${code.replaceAll("-", "").toUpperCase()}`,
      );
      const recoveryIndex =
        action !== "CONFIRM" ? factor.recoveryHashes.indexOf(recoveryHash) : -1;
      if (counter === null && recoveryIndex === -1) {
        await store.update(
          "secondFactors",
          { profileId: ctx.profile.id },
          { failedAttempts: attempts + 1, lastAttemptAt: new Date() },
        );
        return { valid: false };
      }
      let recoveryCodes: string[] | undefined;
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
        const hashes = [...factor.recoveryHashes];
        if (recoveryIndex >= 0) hashes.splice(recoveryIndex, 1);
        if (action === "CONFIRM")
          recoveryCodes = Array.from({ length: 10 }, () =>
            randomBytes(8)
              .toString("hex")
              .toUpperCase()
              .match(/.{4}/g)!
              .join("-"),
          );
        await store.update(
          "secondFactors",
          { profileId: ctx.profile.id },
          {
            encryptedSecret: encrypted,
            pendingEncryptedSecret: null,
            enabledAt: factor.enabledAt ?? new Date(),
            lastCounter: counter ?? factor.lastCounter,
            failedAttempts: 0,
            lastAttemptAt: new Date(),
            recoveryHashes: recoveryCodes
              ? recoveryCodes.map((value) =>
                  networkingHash(
                    `recovery:${ctx.profile.id}:${value.replaceAll("-", "")}`,
                  ),
                )
              : hashes,
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
      return { valid: true, recoveryCodes };
    });
    if (!result.valid)
      throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Invalid, reused or expired authenticator/recovery code" });
    return {
      verified: true,
      ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
    };
  }
}
