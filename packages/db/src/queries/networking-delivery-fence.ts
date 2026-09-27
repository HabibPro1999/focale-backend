import { and, eq, gt, sql } from "drizzle-orm";
import { networkingDeliveries } from "../schema/networking";
import type { NetworkingDeliveryRow } from "./networking-delivery";

/** Keep the caller's clock choice: progress updates use the app clock, report claims use DB now(). */
export function ownedNetworkingDelivery(row: NetworkingDeliveryRow, clock: "app" | "database") {
  return and(
    eq(networkingDeliveries.id, row.id),
    eq(networkingDeliveries.status, "PROCESSING"),
    eq(networkingDeliveries.lockedUntil, row.lockedUntil!),
    clock === "app"
      ? gt(networkingDeliveries.lockedUntil, new Date())
      : sql`${networkingDeliveries.lockedUntil}>now()`,
  );
}

/** Raw SQL callers retain ISO text plus ::timestamp rather than changing date parameter encoding. */
export function ownedNetworkingDeliverySql(row: NetworkingDeliveryRow) {
  return sql`id=${row.id} AND status='PROCESSING' AND locked_until=${row.lockedUntil?.toISOString()}::timestamp AND locked_until>now()`;
}
