import { randomBytes } from "node:crypto";
import type { SponsorshipForCalculation } from "@shared/utils/sponsorship-math.js";

// ============================================================================
// Code Generation
// ============================================================================

const CODE_PREFIX = "SP-";

// Crockford base32 alphabet: uppercase, excludes I/L/O/U to avoid confusion
// when codes are hand-typed by doctors.
const CROCKFORD_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a sponsorship code with ~128 bits of entropy.
 * Format: SP-<26 Crockford-base32 chars>
 *
 * 16 random bytes → 128 bits; each base32 char encodes 5 bits → ceil(128/5) = 26 chars.
 * DB unique constraint (@unique on Sponsorship.code) backstops any theoretical
 * collision — Prisma P2002 will surface as a 500 on the (effectively impossible)
 * collision path.
 */
export function generateSponsorshipCode(): string {
  const bytes = randomBytes(16); // 128 bits
  let bits = 0n;
  for (const byte of bytes) {
    bits = (bits << 8n) | BigInt(byte);
  }

  let code = "";
  for (let i = 0; i < 26; i++) {
    code = CROCKFORD_CHARS[Number(bits & 0x1fn)] + code;
    bits >>= 5n;
  }

  return `${CODE_PREFIX}${code}`;
}

// ============================================================================
// Coverage Application — re-exported from shared
// ============================================================================

export {
  calculateApplicableAmount,
  type SponsorshipForCalculation,
  type RegistrationForCalculation,
} from "@shared/utils/sponsorship-math.js";

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
 * Get the type key for grouping access items.
 * Items with type OTHER are grouped by groupLabel, others by type.
 */
export function getAccessTypeKey(
  type: string,
  groupLabel: string | null,
): string {
  return type === "OTHER" ? `OTHER:${groupLabel || ""}` : type;
}

/**
 * Validate that covered access items don't have time overlaps within the same type group.
 * Groups by type (using groupLabel for OTHER), then does pairwise overlap check.
 *
 * @param coveredAccessIds - Access item IDs to check
 * @param accessItems - Pre-fetched access items with time data
 * @returns Array of error messages (empty if no conflicts)
 */
export function validateCoveredAccessTimeOverlap(
  coveredAccessIds: string[],
  accessItems: AccessItemForOverlapCheck[],
): string[] {
  if (coveredAccessIds.length < 2) return [];

  const errors: string[] = [];
  const accessMap = new Map(accessItems.map((a) => [a.id, a]));

  // Get only covered items
  const coveredItems = coveredAccessIds
    .map((id) => accessMap.get(id))
    .filter((item): item is AccessItemForOverlapCheck => item !== undefined);

  if (coveredItems.length < 2) return [];

  // Group by typeKey (matches access.service.ts pattern)
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
