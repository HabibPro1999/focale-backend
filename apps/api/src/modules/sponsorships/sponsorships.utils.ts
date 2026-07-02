import { randomInt } from "node:crypto";
import type { SponsorshipForCalculation } from "@app/shared";

// Pure helpers ported from legacy sponsorships.utils.ts. No I/O.

// ============================================================================
// Code Generation
// ============================================================================

// Characters excluding O, I, L, 0, 1 to avoid confusion.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_PREFIX = "SP-";

/** Generate a sponsorship code SP-XXXXXXXX (crypto-secure). */
export function generateSponsorshipCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  }
  return `${CODE_PREFIX}${code}`;
}

/**
 * Generate a code unique per the supplied existence check. Throws a plain Error
 * after maxAttempts collisions (legacy behavior — surfaces as a 500, kept).
 */
export async function generateUniqueCode(
  exists: (code: string) => Promise<boolean>,
  maxAttempts = 10,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateSponsorshipCode();
    if (!(await exists(code))) return code;
  }
  throw new Error(
    "Failed to generate unique sponsorship code after maximum attempts",
  );
}

// ============================================================================
// Overlap Detection (advisory warnings)
// ============================================================================

export interface ExistingUsage {
  sponsorshipId: string;
  sponsorship: {
    code: string;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
  };
}

export function detectCoverageOverlap(
  existingUsages: ExistingUsage[],
  newSponsorship: SponsorshipForCalculation,
): string[] {
  const warnings: string[] = [];

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
        warnings.push(
          `Access item ${accessId} is already covered by sponsorship ${accessCodeMap.get(accessId)}`,
        );
      }
    }
  }

  return warnings;
}

// ============================================================================
// Time Overlap Validation
// ============================================================================

export interface AccessItemForOverlapCheck {
  id: string;
  name: string;
  type: string;
  groupLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

/** OTHER types grouped by groupLabel; others by type. */
export function getAccessTypeKey(
  type: string,
  groupLabel: string | null,
): string {
  return type === "OTHER" ? `OTHER:${groupLabel || ""}` : type;
}

/**
 * Pairwise time-overlap check within each type group. Touching boundaries
 * (aEnd === bStart) do NOT count. Items missing start/end are skipped.
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

  const byType = new Map<string, AccessItemForOverlapCheck[]>();
  for (const item of coveredItems) {
    const typeKey = getAccessTypeKey(item.type, item.groupLabel);
    if (!byType.has(typeKey)) byType.set(typeKey, []);
    byType.get(typeKey)!.push(item);
  }

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
// Amount / status derivation
// ============================================================================

export function calculateTotalSponsorshipAmount(
  usages: Array<{ amountApplied: number }>,
): number {
  return usages.reduce((sum, usage) => sum + usage.amountApplied, 0);
}

export function determineSponsorshipStatus(
  sponsorship: { status: string },
  usageCount: number,
): "PENDING" | "USED" | "CANCELLED" {
  if (sponsorship.status === "CANCELLED") return "CANCELLED";
  return usageCount > 0 ? "USED" : "PENDING";
}

// Re-export the pure coverage math (single source in @app/shared).
export {
  calculateApplicableAmount,
  type SponsorshipForCalculation,
  type RegistrationForCalculation,
} from "@app/shared";
