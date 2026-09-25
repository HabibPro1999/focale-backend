import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { networkingKeyring, type NetworkingKeyring } from "@app/shared";
import { getConfig } from "../../core/config";
/**
 * The networking keyring (NETWORKING_KEYS + legacy NETWORKING_TOKEN_SECRET).
 * 503 NETWORKING_AUTH_UNAVAILABLE when no key is configured (NETWORKING_DISABLED).
 */
export function networkingKeys(): NetworkingKeyring {
  const { tokenSecret, keys, keyringWriteV1 } = getConfig().networking;
  const keyring = networkingKeyring({ legacySecret: tokenSecret, keys, writeV1: keyringWriteV1 });
  if (!keyring.configured)
    throw new ServiceUnavailableException({
      code: "NETWORKING_AUTH_UNAVAILABLE",
      message: "Networking authentication is not configured",
    });
  return keyring;
}
/** Stored hash of a participant session token, in the current write format. */
export function networkingHash(token: string) {
  return networkingKeys().mac("session", token);
}
/** Every stored form a session token's hash can have (lookup, then rehash to the current one). */
export function networkingSessionHashes(token: string) {
  return networkingKeys().macCandidates("session", token);
}
const otpValue = (eventId: string, email: string, code: string) => `otp:${eventId}:${email}:${code}`;
export function networkingOtpHash(eventId: string, email: string, code: string) {
  return networkingKeys().mac("otp", otpValue(eventId, email, code));
}
export function verifyNetworkingOtp(eventId: string, email: string, code: string, stored: string) {
  return networkingKeys().verifyMac("otp", otpValue(eventId, email, code), stored);
}
/** Recovery codes are case- and dash-insensitive. */
const recoveryValue = (profileId: string, code: string) =>
  `recovery:${profileId}:${code.replaceAll("-", "").toUpperCase()}`;
export function networkingRecoveryHash(profileId: string, code: string) {
  return networkingKeys().mac("recovery", recoveryValue(profileId, code));
}
/**
 * Index of the stored recovery hash `code` matches, each checked with the key
 * it names (unversioned hashes with the legacy key), or -1.
 */
export function matchNetworkingRecoveryCode(profileId: string, code: string, hashes: readonly string[]) {
  const keyring = networkingKeys();
  const value = recoveryValue(profileId, code);
  return hashes.findIndex((stored) => keyring.verifyMac("recovery", value, stored));
}
/** True when any stored recovery hash uses a key other than the current write key. */
export function networkingRecoveryCodesOutdated(hashes: readonly string[]) {
  const keyring = networkingKeys();
  return hashes.some((stored) => !keyring.isCurrent(stored));
}
export function sealNetworkingCode(code: string) {
  return networkingKeys().seal(code);
}
/** Opens a v1 or legacy seal; throws NetworkingKeyringError when its key is gone or the value is invalid. */
export function openNetworkingSecret(value: string) {
  return networkingKeys().open(value);
}
export function issueNetworkingBadge(profileId: string, eventId: string) {
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const payload = Buffer.from(
    JSON.stringify({ profileId, eventId, expiresAt: expiresAt.toISOString() }),
  ).toString("base64url");
  return {
    token: `${payload}.${networkingKeys().mac("badge", `badge:${payload}`)}`,
    expiresAt: expiresAt.toISOString(),
    profileId,
    accessAllowed: true,
  };
}
export function readNetworkingBadge(token: string, eventId: string) {
  try {
    let linkedProfileId: string | undefined;
    if (/^https?:\/\//i.test(token)) {
      const url = new URL(token);
      const path = url.pathname.match(/^\/e\/[^/]+\/profiles\/([^/]+)$/);
      if (!path || url.username || url.password) throw new Error();
      linkedProfileId = decodeURIComponent(path[1]!);
      // The fragment keeps the attendance proof out of HTTP requests/referrers.
      token = new URLSearchParams(url.hash.slice(1)).get("badge") ?? "";
    }
    if (token.split(".").length !== 2) throw new Error();
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !networkingKeys().verifyMac("badge", `badge:${payload}`, signature))
      throw new Error();
    const parsed = JSON.parse(
      Buffer.from(payload!, "base64url").toString(),
    ) as { profileId: string; eventId: string; expiresAt: string };
    if (
      parsed.eventId !== eventId ||
      (linkedProfileId !== undefined && parsed.profileId !== linkedProfileId) ||
      !Number.isFinite(Date.parse(parsed.expiresAt)) ||
      new Date(parsed.expiresAt).getTime() <= Date.now()
    )
      throw new Error();
    return parsed.profileId;
  } catch {
    throw new BadRequestException({
      code: "NETWORKING_BADGE_INVALID",
      message: "Invalid or expired badge",
    });
  }
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newNetworkingTotpSecret() {
  const bytes = randomBytes(20);
  let bits = 0,
    value = 0,
    result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += base32Alphabet[(value << (5 - bits)) & 31];
  return result;
}
function decodeBase32(secret: string) {
  let value = 0,
    bits = 0;
  const bytes: number[] = [];
  for (const char of secret) {
    const digit = base32Alphabet.indexOf(char);
    if (digit < 0) throw new Error("Invalid TOTP secret");
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
// RFC 6238 / RFC 4226: https://www.rfc-editor.org/rfc/rfc6238.html
export function networkingTotp(
  secret: string,
  counter = Math.floor(Date.now() / 30000),
) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", decodeBase32(secret)).update(bytes).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
export function verifyNetworkingTotp(
  secret: string,
  code: string,
  lastCounter: number,
  now = Date.now(),
) {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(now / 30000);
  for (const value of [counter, counter - 1, counter + 1]) {
    if (value <= lastCounter) continue;
    if (
      timingSafeEqual(
        Buffer.from(networkingTotp(secret, value)),
        Buffer.from(code),
      )
    )
      return value;
  }
  return null;
}
