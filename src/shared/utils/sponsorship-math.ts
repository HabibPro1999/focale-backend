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
  priceBreakdown: {
    calculatedBasePrice?: number;
    accessItems?: Array<{
      accessId: string;
      subtotal: number;
    }>;
  };
}

// ============================================================================
// Pure calculation — no Prisma calls
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
