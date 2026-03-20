import { randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/database/client.js";

// ============================================================================
// Edit Token Configuration
// ============================================================================

const EDIT_TOKEN_LENGTH = 32; // 64 hex characters
export const EDIT_TOKEN_EXPIRY_HOURS = 24;

/**
 * Generate a secure random edit token.
 */
export function generateEditToken(): string {
  return randomBytes(EDIT_TOKEN_LENGTH).toString("hex");
}

/**
 * Calculate edit token expiry date.
 */
export function getEditTokenExpiry(): Date {
  return new Date(Date.now() + EDIT_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
}

/**
 * Verify an edit token for a registration.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param checkExpiry - If true, rejects expired tokens (for edit operations).
 *                      If false, only validates the token value (for read/payment access).
 */
export async function verifyEditToken(
  registrationId: string,
  token: string,
  { checkExpiry = true }: { checkExpiry?: boolean } = {},
): Promise<boolean> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: { editToken: true, editTokenExpiry: true },
  });

  if (!registration?.editToken || !registration.editTokenExpiry) {
    return false;
  }

  // Check expiry only for edit operations — payment/read links stay valid
  if (checkExpiry && registration.editTokenExpiry < new Date()) {
    return false;
  }

  // Timing-safe comparison
  try {
    const isValid = timingSafeEqual(
      Buffer.from(registration.editToken, "utf8"),
      Buffer.from(token, "utf8"),
    );
    return isValid;
  } catch {
    // Buffer length mismatch or other error
    return false;
  }
}
