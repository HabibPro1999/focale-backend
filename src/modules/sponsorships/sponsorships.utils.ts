// ============================================================================
// Code Generation
// ============================================================================

import { randomInt } from "crypto";
import type { ExtendedPrismaClient } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
export { getAccessTypeKey } from "@shared/utils/access-helpers.js";
import { getAccessTypeKey } from "@shared/utils/access-helpers.js";

// Transaction client type derived from the extended Prisma client.
// Used as the parameter type for utility functions that are called in both
// transaction and non-transaction contexts.
type SponsorshipDb = Parameters<
  Parameters<ExtendedPrismaClient["$transaction"]>[0]
>[0];

// Characters for code generation (excluding O, I, L to avoid confusion)
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const CODE_PREFIX = "SP-";

/**
 * Generate a unique sponsorship code (SP-XXXX) by checking against existing codes.
 * Uses characters: A-Z (except O, I, L) and 2-9.
 * Retries up to maxAttempts times before throwing an error.
 */
export async function generateUniqueCode(
  db: SponsorshipDb,
  maxAttempts = 10,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    }
    code = `${CODE_PREFIX}${code}`;
    const existing = await db.sponsorship.findUnique({
      where: { code },
      select: { id: true },
    });

    if (!existing) {
      return code;
    }
  }

  throw new AppError(
    "Failed to generate unique sponsorship code after maximum attempts",
    500,
    true,
    ErrorCodes.INTERNAL_ERROR,
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
  db: SponsorshipDb,
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
// Time Overlap Validation
// ============================================================================

/**
 * Minimal access item shape for time-overlap checking.
 */
export interface AccessItemForOverlapCheck {
  id: string;
  name: string;
  type: string;
  groupLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

/**
 * Validate that covered access items don't have time overlaps within the same type group.
 * Groups by type (using groupLabel for OTHER), then does pairwise overlap check.
 */
export function validateCoveredAccessTimeOverlap(
  coveredAccessIds: string[],
  accessItems: AccessItemForOverlapCheck[],
): string[] {
  if (coveredAccessIds.length < 2) return [];

  const errors: string[] = [];
  const accessMap = new Map(accessItems.map((a) => [a.id, a]));

  const coveredItems = coveredAccessIds
    .map((id) => accessMap.get(id))
    .filter((item): item is AccessItemForOverlapCheck => item !== undefined);

  if (coveredItems.length < 2) return [];

  // Group by typeKey
  const byType = new Map<string, AccessItemForOverlapCheck[]>();
  for (const item of coveredItems) {
    const typeKey = getAccessTypeKey(item.type, item.groupLabel);
    if (!byType.has(typeKey)) byType.set(typeKey, []);
    byType.get(typeKey)!.push(item);
  }

  // Pairwise overlap check within each group
  for (const typeItems of byType.values()) {
    for (let i = 0; i < typeItems.length; i++) {
      for (let j = i + 1; j < typeItems.length; j++) {
        const a = typeItems[i];
        const b = typeItems[j];

        if (a.startsAt && a.endsAt && b.startsAt && b.endsAt) {
          const aStart = a.startsAt.getTime();
          const aEnd = a.endsAt.getTime();
          const bStart = b.startsAt.getTime();
          const bEnd = b.endsAt.getTime();

          if (!(aEnd <= bStart || bEnd <= aStart)) {
            errors.push(`Time conflict: "${a.name}" and "${b.name}" overlap`);
          }
        }
      }
    }
  }

  return errors;
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
