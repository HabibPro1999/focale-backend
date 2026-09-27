/**
 * totalAmount is gross (after pricing rules, before sponsorship).
 * sponsorshipAmount is deducted here exactly once; priceBreakdown.total is net.
 * Registration settlement math. All operands are integer minor units (e.g.
 * millimes for TND) — plain ints, no floats, no rounding. Kept as raw numbers
 * to match the legacy behavior exactly (see sponsorship-math.ts).
 */
export function calculateSettlement(reg: {
  totalAmount: number;
  paidAmount: number;
  sponsorshipAmount: number;
}) {
  const covered = reg.paidAmount + reg.sponsorshipAmount;
  const amountDue = Math.max(0, reg.totalAmount - covered);
  return {
    amountDue,
    netAmount: Math.max(0, reg.totalAmount - reg.sponsorshipAmount),
    isSettled: amountDue === 0 && reg.totalAmount >= 0,
    isPartiallyPaid: covered > 0 && amountDue > 0,
  };
}

/** Keep the caller's gross subtotal policy when updating sponsorship coverage. */
export function withSponsorshipTotal<T extends object>(breakdown: T, subtotal: number, amount: number) {
  return { ...breakdown, sponsorshipTotal: amount, total: Math.max(0, subtotal - amount) };
}

export function isFullySponsored(reg: { sponsorshipAmount: number; totalAmount: number }): boolean {
  return reg.sponsorshipAmount >= reg.totalAmount && reg.totalAmount > 0;
}

export function hasReceivedPayment(reg: { paymentStatus: string; paidAmount: number }): boolean {
  return reg.paymentStatus === "PAID" || reg.paymentStatus === "SPONSORED" || reg.paidAmount > 0;
}
