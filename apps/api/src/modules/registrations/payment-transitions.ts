import { ErrorCodes } from "@app/contracts";
import { AppException } from "../../core/app-exception";

/**
 * Payment status state machine (ported verbatim). Same-status is a no-op; any
 * transition not in the allowed list throws 400 INVALID_PAYMENT_TRANSITION.
 * Enforced by updateRegistration/confirmPayment/uploadPaymentProof — BYPASSED by
 * adminEditRegistration and the sponsorship auto-transitions.
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["VERIFYING", "PARTIAL", "PAID", "SPONSORED", "WAIVED", "REFUNDED"],
  VERIFYING: ["PAID", "PENDING", "REFUNDED"],
  PARTIAL: ["PAID", "SPONSORED", "REFUNDED"],
  PAID: ["REFUNDED"],
  SPONSORED: ["PARTIAL", "REFUNDED"],
  WAIVED: ["PENDING", "REFUNDED"],
  REFUNDED: [],
};

export function validatePaymentTransition(current: string, next: string): void {
  if (current === next) return;
  const allowed = ALLOWED_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new AppException(
      ErrorCodes.INVALID_PAYMENT_TRANSITION,
      `Cannot transition payment from ${current} to ${next}`,
      400,
    );
  }
}
