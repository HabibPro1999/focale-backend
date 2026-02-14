// ============================================================================
// Types for Prisma Client (works with both PrismaClient and transactions)
// ============================================================================

/**
 * Minimal interface for Prisma operations needed by sponsorship utilities.
 * This works with both the main PrismaClient and transaction clients.
 */
interface PrismaLike {
  sponsorship: {
    findUnique: (args: {
      where: { code: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
  eventPricing: {
    findUnique: (args: {
      where: { eventId: string };
      select: { basePrice: true };
    }) => Promise<{ basePrice: number } | null>;
  };
  eventAccess: {
    findMany: (args: {
      where: { id: { in: string[] }; eventId: string; active: boolean };
      select: { price: true };
    }) => Promise<Array<{ price: number }>>;
  };
}

// ============================================================================
// Code Generation
// ============================================================================

import { randomInt } from "crypto";

// Characters for code generation (excluding O, I, L to avoid confusion)
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const CODE_PREFIX = "SP-";

/**
 * Generate a sponsorship code in format SP-XXXX.
 * Uses characters: A-Z (except O, I, L) and 2-9.
 */
export function generateSponsorshipCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    const randomIndex = randomInt(CODE_CHARS.length);
    code += CODE_CHARS[randomIndex];
  }
  return `${CODE_PREFIX}${code}`;
}

/**
 * Generate a unique sponsorship code by checking against existing codes.
 * Retries up to maxAttempts times before throwing an error.
 */
export async function generateUniqueCode(
  db: PrismaLike,
  maxAttempts = 10,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateSponsorshipCode();
    const existing = await db.sponsorship.findUnique({
      where: { code },
      select: { id: true },
    });

    if (!existing) {
      return code;
    }
  }

  throw new Error(
    "Failed to generate unique sponsorship code after maximum attempts",
  );
}

// ============================================================================
// Price Calculation
// ============================================================================

/**
 * Calculate the total sponsorship amount based on coverage.
 * Sums base price (if covered) and prices of covered access items.
 */
export async function calculateSponsorshipTotal(
  db: PrismaLike,
  eventId: string,
  coversBasePrice: boolean,
  coveredAccessIds: string[],
): Promise<number> {
  let total = 0;

  // Get base price if covered
  if (coversBasePrice) {
    const pricing = await db.eventPricing.findUnique({
      where: { eventId },
      select: { basePrice: true },
    });
    total += pricing?.basePrice ?? 0;
  }

  // Get access prices
  if (coveredAccessIds.length > 0) {
    const accessItems = await db.eventAccess.findMany({
      where: {
        id: { in: coveredAccessIds },
        eventId,
        active: true,
      },
      select: { price: true },
    });
    total += accessItems.reduce((sum, item) => sum + item.price, 0);
  }

  return total;
}

// ============================================================================
// Coverage Application
// ============================================================================

/**
 * Sponsorship data needed for calculating applicable amount.
 */
export interface SponsorshipForCalculation {
  coversBasePrice: boolean;
  coveredAccessIds: string[];
  totalAmount: number;
}

/**
 * Registration data needed for calculating applicable amount.
 */
export interface RegistrationForCalculation {
  totalAmount: number;
  baseAmount: number;
  accessTypeIds: string[];
  priceBreakdown: {
    calculatedBasePrice?: number;
    accessItems?: Array<{
      accessId: string;
      subtotal: number;
    }>;
  };
}

/**
 * Calculate the applicable sponsorship amount for a registration.
 * Returns the intersection of what the sponsorship covers and what the registration selected.
 */
export function calculateApplicableAmount(
  sponsorship: SponsorshipForCalculation,
  registration: RegistrationForCalculation,
): number {
  let applicableAmount = 0;

  // Apply base price if covered by sponsorship
  if (sponsorship.coversBasePrice) {
    applicableAmount +=
      registration.priceBreakdown.calculatedBasePrice ??
      registration.baseAmount;
  }

  // Apply covered access items that are also in registration
  if (
    sponsorship.coveredAccessIds.length > 0 &&
    registration.priceBreakdown.accessItems
  ) {
    const registrationAccessIds = new Set(registration.accessTypeIds);

    for (const coveredId of sponsorship.coveredAccessIds) {
      if (registrationAccessIds.has(coveredId)) {
        const accessItem = registration.priceBreakdown.accessItems.find(
          (item) => item.accessId === coveredId,
        );
        if (accessItem) {
          applicableAmount += accessItem.subtotal;
        }
      }
    }
  }

  // Don't exceed the registration total or sponsorship total
  return Math.min(
    applicableAmount,
    registration.totalAmount,
    sponsorship.totalAmount,
  );
}

// ============================================================================
// Overlap Detection
// ============================================================================

/**
 * Existing sponsorship usage with coverage info.
 */
export interface ExistingUsage {
  sponsorshipId: string;
  sponsorship: {
    code: string;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
  };
}

/**
 * Detect coverage overlap between existing sponsorship usages and a new sponsorship.
 * Returns an array of warning messages.
 */
export function detectCoverageOverlap(
  existingUsages: ExistingUsage[],
  newSponsorship: SponsorshipForCalculation,
): string[] {
  const warnings: string[] = [];

  // Check for base price overlap
  if (newSponsorship.coversBasePrice) {
    const existingBaseCoverage = existingUsages.find(
      (usage) => usage.sponsorship.coversBasePrice,
    );
    if (existingBaseCoverage) {
      warnings.push(
        `Base price is already covered by sponsorship ${existingBaseCoverage.sponsorship.code}`,
      );
    }
  }

  // Check for access item overlaps
  if (newSponsorship.coveredAccessIds.length > 0) {
    const existingCoveredAccessIds = new Set<string>();
    const accessCodeMap = new Map<string, string>();

    for (const usage of existingUsages) {
      for (const accessId of usage.sponsorship.coveredAccessIds) {
        existingCoveredAccessIds.add(accessId);
        accessCodeMap.set(accessId, usage.sponsorship.code);
      }
    }

    for (const accessId of newSponsorship.coveredAccessIds) {
      if (existingCoveredAccessIds.has(accessId)) {
        const existingCode = accessCodeMap.get(accessId);
        warnings.push(
          `Access item ${accessId} is already covered by sponsorship ${existingCode}`,
        );
      }
    }
  }

  return warnings;
}

// ============================================================================
// Amount Capping
// ============================================================================

/**
 * Cap the applicable amount so total sponsorship does not exceed registration total.
 * Returns the capped amount.
 */
export function capSponsorshipAmount(
  applicableAmount: number,
  existingSponsorshipAmount: number,
  registrationTotalAmount: number,
): number {
  const remainingCapacity = Math.max(
    0,
    registrationTotalAmount - existingSponsorshipAmount,
  );
  return Math.min(applicableAmount, remainingCapacity);
}

// ============================================================================
// Recalculation Helpers
// ============================================================================

/**
 * Recalculate total sponsorship amount for a registration based on all linked usages.
 */
export function calculateTotalSponsorshipAmount(
  usages: Array<{ amountApplied: number }>,
): number {
  return usages.reduce((sum, usage) => sum + usage.amountApplied, 0);
}

/**
 * Determine the correct sponsorship status based on its usages.
 * - PENDING if no usages
 * - USED if has any usages
 * - (CANCELLED status is set explicitly, not derived)
 */
export function determineSponsorshipStatus(
  sponsorship: { status: string },
  usageCount: number,
): "PENDING" | "USED" | "CANCELLED" {
  if (sponsorship.status === "CANCELLED") {
    return "CANCELLED";
  }
  return usageCount > 0 ? "USED" : "PENDING";
}
