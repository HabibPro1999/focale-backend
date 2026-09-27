// Report analytics reads: summary aggregates, payment/access breakdowns, daily
// trends and the access-registrants data. Read-only; see ../reports.ts.

import { and, asc, avg, count, desc, eq, gte, inArray, lte, sql, sum, type SQL } from "drizzle-orm";
import { getDb, type DbExecutor } from "../../client";
import { rowsOf } from "../../helpers";
import { registrations } from "../../schema/registrations";
import { events, eventAccess } from "../../schema/events-access";
import { sponsorships } from "../../schema/sponsorships";

type RegistrationRow = typeof registrations.$inferSelect;

/** sum() over an integer column returns string|null; coerce to a JS number. */
function num(v: string | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

// ============================================================================
// Shared where builders
// ============================================================================

export interface DateRange {
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * eventId + optional submitted_at gte/lte. Merge semantics match the legacy
 * dateWhere object (only-endDate sets lte, only-startDate sets gte).
 */
function eventDateWhere(eventId: string, dateRange: DateRange, extra?: SQL): SQL {
  const clauses: (SQL | undefined)[] = [eq(registrations.eventId, eventId)];
  if (dateRange.startDate) clauses.push(gte(registrations.submittedAt, dateRange.startDate));
  if (dateRange.endDate) clauses.push(lte(registrations.submittedAt, dateRange.endDate));
  if (extra) clauses.push(extra);
  return and(...clauses) as SQL;
}

// ============================================================================
// Financial report
// ============================================================================

export interface FinancialCurrencyRow {
  currency: string;
  totalAmount: number;
  paidAmount: number;
  baseAmount: number;
  accessAmount: number;
  discountAmount: number;
  sponsorshipAmount: number;
  count: number;
}

export interface FinancialSummaryAggregates {
  byCurrency: FinancialCurrencyRow[];
  pendingByCurrency: Array<{ currency: string; totalAmount: number; paidAmount: number }>;
  refundedByCurrency: Array<{ currency: string; totalAmount: number }>;
  revenueByCurrency: Array<{ currency: string; paidAmount: number }>;
  overall: {
    baseAmount: number;
    accessAmount: number;
    discountAmount: number;
    sponsorshipAmount: number;
    avgTotalAmount: number;
    count: number;
  };
  overallRevenuePaid: number;
}

const PENDING_STATUSES = ["PENDING", "VERIFYING", "PARTIAL"] as const;

export async function getFinancialSummaryAggregates(
  eventId: string,
  dateRange: DateRange,
): Promise<FinancialSummaryAggregates> {
  const db = getDb();
  const base = eventDateWhere(eventId, dateRange);

  const [byCurrency, pendingByCurrency, refundedByCurrency, revenueByCurrency, overallRow, overallRevenueRow] =
    await Promise.all([
      db
        .select({
          currency: registrations.currency,
          totalAmount: sum(registrations.totalAmount),
          paidAmount: sum(registrations.paidAmount),
          baseAmount: sum(registrations.baseAmount),
          accessAmount: sum(registrations.accessAmount),
          discountAmount: sum(registrations.discountAmount),
          sponsorshipAmount: sum(registrations.sponsorshipAmount),
          count: count(),
        })
        .from(registrations)
        .where(base)
        .groupBy(registrations.currency),
      db
        .select({
          currency: registrations.currency,
          totalAmount: sum(registrations.totalAmount),
          paidAmount: sum(registrations.paidAmount),
        })
        .from(registrations)
        .where(
          eventDateWhere(
            eventId,
            dateRange,
            inArray(registrations.paymentStatus, PENDING_STATUSES as unknown as RegistrationRow["paymentStatus"][]),
          ),
        )
        .groupBy(registrations.currency),
      db
        .select({
          currency: registrations.currency,
          totalAmount: sum(registrations.totalAmount),
        })
        .from(registrations)
        .where(eventDateWhere(eventId, dateRange, eq(registrations.paymentStatus, "REFUNDED")))
        .groupBy(registrations.currency),
      db
        .select({
          currency: registrations.currency,
          paidAmount: sum(registrations.paidAmount),
        })
        .from(registrations)
        .where(
          eventDateWhere(
            eventId,
            dateRange,
            sql`${registrations.paymentStatus} != 'REFUNDED'`,
          ),
        )
        .groupBy(registrations.currency),
      db
        .select({
          baseAmount: sum(registrations.baseAmount),
          accessAmount: sum(registrations.accessAmount),
          discountAmount: sum(registrations.discountAmount),
          sponsorshipAmount: sum(registrations.sponsorshipAmount),
          avgTotalAmount: avg(registrations.totalAmount),
          count: count(),
        })
        .from(registrations)
        .where(base),
      db
        .select({ paidAmount: sum(registrations.paidAmount) })
        .from(registrations)
        .where(eventDateWhere(eventId, dateRange, sql`${registrations.paymentStatus} != 'REFUNDED'`)),
    ]);

  const overall = overallRow[0];
  return {
    byCurrency: byCurrency.map((c) => ({
      currency: c.currency,
      totalAmount: num(c.totalAmount),
      paidAmount: num(c.paidAmount),
      baseAmount: num(c.baseAmount),
      accessAmount: num(c.accessAmount),
      discountAmount: num(c.discountAmount),
      sponsorshipAmount: num(c.sponsorshipAmount),
      count: c.count,
    })),
    pendingByCurrency: pendingByCurrency.map((p) => ({
      currency: p.currency,
      totalAmount: num(p.totalAmount),
      paidAmount: num(p.paidAmount),
    })),
    refundedByCurrency: refundedByCurrency.map((r) => ({
      currency: r.currency,
      totalAmount: num(r.totalAmount),
    })),
    revenueByCurrency: revenueByCurrency.map((r) => ({
      currency: r.currency,
      paidAmount: num(r.paidAmount),
    })),
    overall: {
      baseAmount: num(overall?.baseAmount),
      accessAmount: num(overall?.accessAmount),
      discountAmount: num(overall?.discountAmount),
      sponsorshipAmount: num(overall?.sponsorshipAmount),
      avgTotalAmount: num(overall?.avgTotalAmount),
      count: overall?.count ?? 0,
    },
    overallRevenuePaid: num(overallRevenueRow[0]?.paidAmount),
  };
}

export interface PaymentStatusBreakdownRow {
  paymentStatus: string;
  count: number;
  totalAmount: number;
}

export async function getPaymentStatusBreakdown(
  eventId: string,
  dateRange: DateRange,
): Promise<PaymentStatusBreakdownRow[]> {
  const rows = await getDb()
    .select({
      paymentStatus: registrations.paymentStatus,
      count: count(),
      totalAmount: sum(registrations.totalAmount),
    })
    .from(registrations)
    .where(eventDateWhere(eventId, dateRange))
    .groupBy(registrations.paymentStatus);
  return rows.map((g) => ({
    paymentStatus: g.paymentStatus,
    count: g.count,
    totalAmount: num(g.totalAmount),
  }));
}

export interface AccessBreakdownRow {
  accessType: string;
  count: number;
  totalAmount: number;
}

/**
 * Settled-only (PAID/SPONSORED/WAIVED) breakdown unnested from the
 * price_breakdown JSONB accessItems array. NOTE the deliberate divergence from
 * the top-level financial summary, which counts ALL statuses — this raw SQL
 * counts only settled registrations. Ported byte-for-byte.
 */
export async function getAccessBreakdown(
  eventId: string,
  dateRange: DateRange,
): Promise<AccessBreakdownRow[]> {
  const db = getDb();
  const startDateCondition = dateRange.startDate
    ? sql` AND r.submitted_at >= ${dateRange.startDate}`
    : sql``;
  const endDateCondition = dateRange.endDate
    ? sql` AND r.submitted_at <= ${dateRange.endDate}`
    : sql``;

  const res = await db.execute(sql`
    SELECT
      (item->>'accessId')::TEXT AS access_id,
      COUNT(*) AS count,
      COALESCE(SUM((item->>'subtotal')::INTEGER), 0) AS total_amount
    FROM registrations r,
    LATERAL jsonb_array_elements(r.price_breakdown->'accessItems') AS item
    WHERE r.event_id = ${eventId}
      AND r.payment_status IN ('PAID', 'SPONSORED', 'WAIVED')
      AND jsonb_array_length(COALESCE(r.price_breakdown->'accessItems', '[]'::jsonb)) > 0
      ${startDateCondition}
      ${endDateCondition}
    GROUP BY (item->>'accessId')::TEXT
  `);
  const accessData = rowsOf<{ access_id: string; count: bigint | string; total_amount: bigint | string }>(res);

  const accessIds = accessData.map((a) => a.access_id);
  if (accessIds.length === 0) return [];

  const accessItems = await db
    .select({ id: eventAccess.id, name: eventAccess.name, type: eventAccess.type })
    .from(eventAccess)
    .where(inArray(eventAccess.id, accessIds));

  const accessMap = new Map(accessItems.map((a) => [a.id, a]));
  return accessData.map((g) => {
    const access = accessMap.get(g.access_id);
    return {
      accessType: access?.name ?? access?.type ?? "Unknown",
      count: Number(g.count),
      totalAmount: Number(g.total_amount),
    };
  });
}

export interface DailyTrendRow {
  date: Date;
  count: number;
  totalAmount: number;
}

/** DATE(submitted_at) grouping — the service formats date -> YYYY-MM-DD. */
export async function getDailyTrendRows(
  eventId: string,
  dateRange: DateRange,
): Promise<DailyTrendRow[]> {
  const endDate = dateRange.endDate ?? new Date();
  const startDate =
    dateRange.startDate ?? new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  const res = await getDb().execute(sql`
    SELECT
      DATE(submitted_at) as date,
      COUNT(*) as count,
      COALESCE(SUM(total_amount), 0) as total_amount
    FROM registrations
    WHERE event_id = ${eventId}
      AND submitted_at >= ${startDate}
      AND submitted_at <= ${endDate}
    GROUP BY DATE(submitted_at)
    ORDER BY date ASC
  `);
  return rowsOf<{ date: Date; count: bigint | string; total_amount: bigint | string }>(res).map(
    (r) => ({
      date: r.date instanceof Date ? r.date : new Date(r.date),
      count: Number(r.count),
      totalAmount: Number(r.total_amount),
    }),
  );
}

// ============================================================================
// Event analytics
// ============================================================================

export interface EventAnalyticsData {
  paymentsByStatus: Array<{ paymentStatus: string; count: number }>;
  paymentsByMethod: Array<{ paymentMethod: string | null; count: number }>;
  accessItems: Array<{
    id: string;
    name: string;
    type: string;
    registeredCount: number;
    maxCapacity: number | null;
  }>;
  sponsorshipsByStatus: Array<{ status: string; count: number }>;
}

export async function getEventAnalyticsData(eventId: string): Promise<EventAnalyticsData> {
  const db = getDb();
  const [paymentsByStatus, paymentsByMethod, accessItems, sponsorshipsByStatus] =
    await Promise.all([
      db
        .select({ paymentStatus: registrations.paymentStatus, count: count() })
        .from(registrations)
        .where(eq(registrations.eventId, eventId))
        .groupBy(registrations.paymentStatus),
      db
        .select({ paymentMethod: registrations.paymentMethod, count: count() })
        .from(registrations)
        .where(eq(registrations.eventId, eventId))
        .groupBy(registrations.paymentMethod),
      db
        .select({
          id: eventAccess.id,
          name: eventAccess.name,
          type: eventAccess.type,
          registeredCount: eventAccess.registeredCount,
          maxCapacity: eventAccess.maxCapacity,
        })
        .from(eventAccess)
        .where(eq(eventAccess.eventId, eventId))
        .orderBy(asc(eventAccess.startsAt)),
      db
        .select({ status: sponsorships.status, count: count() })
        .from(sponsorships)
        .where(eq(sponsorships.eventId, eventId))
        .groupBy(sponsorships.status),
    ]);
  return { paymentsByStatus, paymentsByMethod, accessItems, sponsorshipsByStatus };
}

// ============================================================================
// Access registrants drill-down
// ============================================================================

export interface AccessRegistrantRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  paymentStatus: string;
  paidAmount: number;
  totalAmount: number;
  currency: string;
  submittedAt: Date;
}

export interface AccessRegistrantsData {
  access: { name: string; type: string } | null;
  registrations: AccessRegistrantRow[];
}

export async function getAccessRegistrantsData(
  eventId: string,
  accessId: string,
): Promise<AccessRegistrantsData> {
  const db = getDb();
  const [access, regs] = await Promise.all([
    db
      .select({ name: eventAccess.name, type: eventAccess.type })
      .from(eventAccess)
      .where(and(eq(eventAccess.id, accessId), eq(eventAccess.eventId, eventId)))
      .limit(1),
    db
      .select({
        id: registrations.id,
        firstName: registrations.firstName,
        lastName: registrations.lastName,
        email: registrations.email,
        phone: registrations.phone,
        paymentStatus: registrations.paymentStatus,
        paidAmount: registrations.paidAmount,
        totalAmount: registrations.totalAmount,
        currency: registrations.currency,
        submittedAt: registrations.submittedAt,
      })
      .from(registrations)
      .where(
        and(
          eq(registrations.eventId, eventId),
          sql`${accessId}::text = ANY(${registrations.accessTypeIds})`,
        ),
      )
      .orderBy(desc(registrations.submittedAt)),
  ]);
  return { access: access[0] ?? null, registrations: regs };
}

// ============================================================================
// CSV / JSON / XLSX registrations export (GET)
// ============================================================================

export async function getEventSlug(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<{ slug: string } | null> {
  const rows = await db
    .select({ slug: events.slug })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return rows[0] ?? null;
}
