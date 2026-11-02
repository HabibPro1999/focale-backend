import { count } from "drizzle-orm";
import { PaymentStatusSchema, type PlatformRegistrationAggregateResponse } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { registrations } from "../schema/registrations";

/** Counts only; never adds amounts from different currencies or reads personal rows. */
export async function getPlatformRegistrationAggregate(db: DbExecutor = getDb()): Promise<PlatformRegistrationAggregateResponse> {
  const rows = await db.select({ paymentStatus: registrations.paymentStatus, count: count() })
    .from(registrations).groupBy(registrations.paymentStatus);
  const counts = new Map(rows.map((row) => [row.paymentStatus, Number(row.count)]));
  const byPaymentStatus = PaymentStatusSchema.options.map((paymentStatus) => ({ paymentStatus, count: counts.get(paymentStatus) ?? 0 }));
  return { total: byPaymentStatus.reduce((total, row) => total + row.count, 0), byPaymentStatus };
}
