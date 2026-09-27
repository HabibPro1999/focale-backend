import { calculateSettlement, isFullySponsored as hasFullSponsorship } from "@app/shared";

/** Legacy link/batch precedence: PAID/WAIVED sticky, else SPONSORED/PARTIAL/unchanged. */
export function nextStatusOnApply(
  current: string,
  isFullySponsored: boolean,
  amount: number,
): string {
  if (current === "PAID" || current === "WAIVED") return current;
  if (isFullySponsored) return "SPONSORED";
  if (amount > 0) return "PARTIAL";
  return current;
}

/** Unlink intentionally leaves every other status unassigned. */
export function statusAfterUnlink(
  currentStatus: string, newSponsorshipAmount: number, totalAmount: number, paidAmount: number,
): string | undefined {
  let nextStatus: string | undefined;
  if (currentStatus === "SPONSORED" && newSponsorshipAmount < totalAmount) {
    nextStatus =
      paidAmount > 0 || newSponsorshipAmount > 0 ? "PARTIAL" : "PENDING";
  } else if (currentStatus === "PARTIAL" && newSponsorshipAmount === 0) {
    nextStatus = paidAmount > 0 ? "PARTIAL" : "PENDING";
  }
  return nextStatus;
}

/** Recalc keeps REFUNDED but overwrites VERIFYING; do not merge with registration settlement. */
export function statusAfterRecalc(
  registration: { paymentStatus: string; totalAmount: number; paidAt: Date | null },
  totalSponsorshipAmount: number,
  settlement: { isPartiallyPaid: boolean },
): { nextPaymentStatus: string; nextPaidAt: Date | null } {
  const oldPaymentStatus = registration.paymentStatus;
  const nextPaymentStatus =
    oldPaymentStatus === "PAID" ||
    oldPaymentStatus === "WAIVED" ||
    oldPaymentStatus === "REFUNDED"
      ? oldPaymentStatus
      : hasFullSponsorship({ sponsorshipAmount: totalSponsorshipAmount, totalAmount: registration.totalAmount })
        ? "SPONSORED"
        : settlement.isPartiallyPaid
          ? "PARTIAL"
          : "PENDING";
  const nextPaidAt =
    nextPaymentStatus === "SPONSORED"
      ? (registration.paidAt ?? new Date())
      : nextPaymentStatus === "PARTIAL" || nextPaymentStatus === "PENDING"
        ? null
        : registration.paidAt;
  return { nextPaymentStatus, nextPaidAt };
}

type RegistrationSettlementPatch = {
  paymentStatus?: "PENDING" | "PARTIAL" | "SPONSORED" | "PAID";
  paidAt?: Date | null;
};

/** Registration repricing keeps VERIFYING and can promote cash-plus-sponsorship to PAID. */
export function statusAfterRegistrationRecalc(
  registration: { paymentStatus: string; paidAt: Date | null; paidAmount: number },
  sponsorshipAmount: number,
  totalAmount: number,
): RegistrationSettlementPatch {
  const result: RegistrationSettlementPatch = {};
  if (
    registration.paymentStatus === "WAIVED" ||
    registration.paymentStatus === "REFUNDED" ||
    registration.paymentStatus === "PAID" ||
    registration.paymentStatus === "VERIFYING"
  ) {
    return result;
  }

  const settlement = calculateSettlement({
    totalAmount,
    paidAmount: registration.paidAmount,
    sponsorshipAmount,
  });
  if (hasFullSponsorship({ sponsorshipAmount, totalAmount })) {
    result.paymentStatus = "SPONSORED";
  } else if (
    settlement.isSettled &&
    registration.paidAmount > 0
  ) {
    result.paymentStatus = "PAID";
  } else {
    result.paymentStatus = settlement.isPartiallyPaid ? "PARTIAL" : "PENDING";
  }
  if (result.paymentStatus !== undefined) {
    result.paidAt =
      result.paymentStatus === "PAID" || result.paymentStatus === "SPONSORED"
        ? registration.paidAt ?? new Date()
        : null;
  }
  return result;
}
