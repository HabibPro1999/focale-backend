import { createHash, randomBytes } from "crypto";

const TOKEN_LENGTH = 32; // 64 hex characters

/**
 * Generate a secure random committee invite token.
 *
 * The raw token is emailed exactly once; only its sha256 hash is persisted, so
 * a database leak cannot be replayed into a password reset.
 */
export function generateCommitteeInviteToken(): string {
  return randomBytes(TOKEN_LENGTH).toString("hex");
}

/**
 * Hash a raw committee invite token for storage/lookup.
 *
 * A plain sha256 (no salt/stretching) is deliberate: the token is 256 bits of
 * CSPRNG output, so it is not brute-forceable and the hash must stay
 * deterministic to support a unique-index lookup.
 */
export function hashCommitteeInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
