import { ErrorCodes } from "@app/contracts";
import type { SettlementStatus } from "@app/shared";
import { AppException } from "../../core/app-exception";

/**
 * Payment status state machine for the payment paths (admin partial update,
 * payment confirmation, payment-proof upload). Same-status is a no-op; any
 * transition not listed throws 400 INVALID_PAYMENT_TRANSITION. Public paths
 * add their own stricter preconditions on top (method selection only from
 * PENDING). VERIFYING → PARTIAL: an admin reviewing a proof of a partial
 * payment (plan 2.6).
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["VERIFYING", "PARTIAL", "PAID", "SPONSORED", "WAIVED", "REFUNDED"],
  VERIFYING: ["PAID", "PARTIAL", "PENDING", "REFUNDED"],
  PARTIAL: ["PAID", "SPONSORED", "REFUNDED"],
  PAID: ["REFUNDED"],
  SPONSORED: ["PARTIAL", "REFUNDED"],
  WAIVED: ["PENDING", "REFUNDED"],
  REFUNDED: [],
};

/**
 * Admin-override transitions for the full admin edit, which may correct a
 * status in any direction except out of REFUNDED: a refund is final.
 */
export const ADMIN_OVERRIDE_TRANSITIONS: Readonly<Record<SettlementStatus, readonly SettlementStatus[]>> = {
  PENDING: ["VERIFYING", "PARTIAL", "PAID", "SPONSORED", "WAIVED", "REFUNDED"],
  VERIFYING: ["PENDING", "PARTIAL", "PAID", "SPONSORED", "WAIVED", "REFUNDED"],
  PARTIAL: ["PENDING", "VERIFYING", "PAID", "SPONSORED", "WAIVED", "REFUNDED"],
  PAID: ["PENDING", "VERIFYING", "PARTIAL", "SPONSORED", "WAIVED", "REFUNDED"],
  SPONSORED: ["PENDING", "VERIFYING", "PARTIAL", "PAID", "WAIVED", "REFUNDED"],
  WAIVED: ["PENDING", "VERIFYING", "PARTIAL", "PAID", "SPONSORED", "REFUNDED"],
  REFUNDED: [],
};

function assertTransition(
  table: Readonly<Record<string, readonly string[]>>,
  current: string,
  next: string,
): void {
  if (current === next) return;
  const allowed = table[current] ?? [];
  if (!allowed.includes(next)) {
    throw new AppException(
      ErrorCodes.INVALID_PAYMENT_TRANSITION,
      `Cannot transition payment from ${current} to ${next}`,
      400,
    );
  }
}

export function validatePaymentTransition(current: string, next: string): void {
  assertTransition(ALLOWED_TRANSITIONS, current, next);
}

/** The admin edit's status change: anything but leaving REFUNDED. */
export function validateAdminPaymentOverride(current: string, next: string): void {
  assertTransition(ADMIN_OVERRIDE_TRANSITIONS, current, next);
}
