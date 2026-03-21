import { randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/database/client.js";

// ============================================================================
// Edit Token Configuration
// ============================================================================

const EDIT_TOKEN_LENGTH = 32; // 64 hex characters

/**
 * Generate a secure random edit token.
 */
export function generateEditToken(): string {
  return randomBytes(EDIT_TOKEN_LENGTH).toString("hex");
}

/**
 * Verify an edit token for a registration.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function verifyEditToken(
  registrationId: string,
  token: string,
): Promise<boolean> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: { editToken: true },
  });

  if (!registration?.editToken) {
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
