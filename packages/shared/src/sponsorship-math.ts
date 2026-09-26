import type { AccessLineItem, PriceBreakdown } from "@app/contracts";

// ============================================================================
// Types for sponsorship amount calculation
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
  /**
   * The parts of the registration's price breakdown a sponsorship can cover
   * (the pricing quote passes them before the sponsorship lines exist). Both
   * are tolerated missing: the base then falls back to `baseAmount` and no
   * access item is covered.
   */
  priceBreakdown: Partial<
    Pick<PriceBreakdown, "calculatedBasePrice"> & {
      accessItems: ReadonlyArray<Pick<AccessLineItem, "accessId" | "subtotal">>;
    }
  >;
}

// ============================================================================
// Pure calculation — no DB calls. Integer minor-unit money math (no floats).
// ============================================================================

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

/**
 * A sponsorship code as stored and matched: trimmed and upper-cased (codes are
 * generated upper-case). Null for a missing or blank code. The signup path,
 * the pricing quote and the code repair all match codes through this.
 */
export function normalizeSponsorshipCode(code: string | null | undefined): string | null {
  const normalized = code?.trim().toUpperCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}
