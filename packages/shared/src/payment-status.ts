/**
 * Every registration payment status: the PaymentStatus enum of the database
 * and of `@app/contracts` (a db unit test keeps the three identical).
 */
export const PAYMENT_STATUSES = [
  "PENDING",
  "VERIFYING",
  "PARTIAL",
  "PAID",
  "SPONSORED",
  "WAIVED",
  "REFUNDED",
] as const;

export type SettlementStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Payment statuses that settle a registration in full: nothing is owed and
 * every selected item occupies paid capacity. PARTIAL settles only the items a
 * sponsorship covers; PENDING and VERIFYING still owe money; REFUNDED is
 * neither owed nor settled.
 */
export const FULLY_SETTLED_STATUSES = ["PAID", "SPONSORED", "WAIVED"] as const;

export type FullySettledStatus = (typeof FULLY_SETTLED_STATUSES)[number];

export function isFullySettled(status: string | null | undefined): status is FullySettledStatus {
  return (FULLY_SETTLED_STATUSES as readonly string[]).includes(status ?? "");
}
