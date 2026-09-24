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
