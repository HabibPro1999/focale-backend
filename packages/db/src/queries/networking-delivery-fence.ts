import { and, eq, sql, type SQL } from "drizzle-orm";
import { networkingDeliveries } from "../schema/networking";

type DeliveryLease = Pick<typeof networkingDeliveries.$inferSelect, "id" | "lockedUntil">;

/** The same lease identity with a caller-supplied expiry test: app/DB clocks stay distinct. */
export function networkingDeliveryFence(row: DeliveryLease, notExpired: SQL) {
  return and(
    eq(networkingDeliveries.id, row.id),
    eq(networkingDeliveries.status, "PROCESSING"),
    eq(networkingDeliveries.lockedUntil, row.lockedUntil!),
    notExpired,
  );
}

/** Raw SQL callers keep their original timestamp cast, expiry clause and row lock. */
export function networkingDeliveryLeaseIdentity(row: DeliveryLease) {
  return sql`id=${row.id} AND status='PROCESSING' AND locked_until=${row.lockedUntil?.toISOString()}::timestamp`;
}
