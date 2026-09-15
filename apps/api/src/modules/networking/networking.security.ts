import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
export function networkingSecret() {
  const value = process.env.NETWORKING_TOKEN_SECRET;
  if (!value || value.length < 32)
    throw new ServiceUnavailableException({
      code: "NETWORKING_AUTH_UNAVAILABLE",
      message: "Networking authentication is not configured",
    });
  return value;
}
export function networkingHash(value: string) {
  return createHmac("sha256", networkingSecret()).update(value).digest("hex");
}
export function sealNetworkingCode(code: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update(networkingSecret()).digest(),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(code, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((v) => v.toString("base64url"))
    .join(".");
}
export function issueNetworkingBadge(profileId: string, eventId: string) {
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const payload = Buffer.from(
    JSON.stringify({ profileId, eventId, expiresAt: expiresAt.toISOString() }),
  ).toString("base64url");
  return {
    token: `${payload}.${networkingHash(`badge:${payload}`)}`,
    expiresAt: expiresAt.toISOString(),
    profileId,
    accessAllowed: true,
  };
}
export function readNetworkingBadge(token: string, eventId: string) {
  try {
    if (token.split(".").length !== 2) throw new Error();
    const [payload, signature] = token.split(".");
    const expected = networkingHash(`badge:${payload}`);
    if (
      !signature ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new Error();
    const parsed = JSON.parse(
      Buffer.from(payload!, "base64url").toString(),
    ) as { profileId: string; eventId: string; expiresAt: string };
    if (
      parsed.eventId !== eventId ||
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

export function openNetworkingSecret(value: string) {
  const [iv, tag, ciphertext] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(networkingSecret()).digest(),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
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
