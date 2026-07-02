/**
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
