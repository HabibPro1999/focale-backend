import { randomBytes, timingSafeEqual, createHash } from "crypto";
import { prisma } from "@/database/client.js";
import { auditLog } from "@shared/utils/audit.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

// ============================================================================
// Edit Token Configuration
// ============================================================================

const EDIT_TOKEN_LENGTH = 32; // produces 64 hex characters

/**
 * Hash a plaintext edit token with SHA-256.
 * Input is already 256-bit cryptographic random so no salt is needed.
 * Returns a 64-char lowercase hex string.
 */
export function hashEditToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Generate a secure random edit token (plaintext).
 * Caller is responsible for hashing before storage and sending plaintext to registrant.
 */
export function generateEditToken(): string {
  return randomBytes(EDIT_TOKEN_LENGTH).toString("hex");
}

/**
 * Verify an edit token for a registration.
 *
 * - Hashes the provided token with SHA-256 and compares timing-safely to the stored hash.
 * - Checks expiry: token is valid while now < event.startDate (dynamic — auto-adjusts if
 *   admin moves the event date).
 * - Logs verification failures to the audit trail (not_found | expired | hash_mismatch).
 * - Successful verifications are NOT audited (the subsequent edit action is its own entry).
 *
 * Returns `{ valid: true }` or `{ valid: false, reason }`.
 */
export async function verifyEditToken(
  registrationId: string,
  token: string,
): Promise<boolean> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: {
      editTokenHash: true,
      event: { select: { startDate: true } },
    },
  });

  if (!registration) {
    await _auditFailure(registrationId, "not_found");
    return false;
  }

  if (!registration.editTokenHash) {
    // No token set (admin-created registration or token never issued)
    await _auditFailure(registrationId, "not_found");
    return false;
  }

  // Check dynamic expiry: token valid while now < event.startDate
  const now = new Date();
  if (registration.event.startDate <= now) {
    await _auditFailure(registrationId, "expired");
    throw new AppError(
      "Edit link has expired — the event has already started",
      403,
      ErrorCodes.EDIT_TOKEN_EXPIRED,
    );
  }

  // Timing-safe hash comparison
  const providedHash = hashEditToken(token);
  try {
    const isValid = timingSafeEqual(
      Buffer.from(registration.editTokenHash, "utf8"),
      Buffer.from(providedHash, "utf8"),
    );
    if (!isValid) {
      await _auditFailure(registrationId, "hash_mismatch");
    }
    return isValid;
  } catch {
    // Buffer length mismatch or other error — treat as mismatch
    await _auditFailure(registrationId, "hash_mismatch");
    return false;
  }
}

/** Best-effort audit log for a verification failure. Never throws. */
async function _auditFailure(
  registrationId: string,
  reason: "not_found" | "expired" | "hash_mismatch",
): Promise<void> {
  await auditLog(prisma, {
    entityType: "Registration",
    entityId: registrationId,
    action: "EDIT_TOKEN_INVALID",
    performedBy: "PUBLIC",
    changes: { reason: { old: null, new: reason } },
  }).catch(() => undefined);
}
