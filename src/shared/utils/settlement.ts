import type { PaymentStatus } from "@/generated/prisma/client.js";

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

export function derivePaymentStatus(reg: {
  totalAmount: number;
  paidAmount: number;
  sponsorshipAmount: number;
  currentStatus: PaymentStatus;
}): PaymentStatus {
  if (reg.currentStatus === "REFUNDED" || reg.currentStatus === "WAIVED" || reg.currentStatus === "VERIFYING") {
    return reg.currentStatus;
  }
  const { isSettled, isPartiallyPaid } = calculateSettlement(reg);
  if (isSettled) {
    if (reg.sponsorshipAmount >= reg.totalAmount) return "SPONSORED";
    return "PAID";
  }
  if (isPartiallyPaid) return "PARTIAL";
  return "PENDING";
}
