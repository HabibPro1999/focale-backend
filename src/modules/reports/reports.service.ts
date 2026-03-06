// ============================================================================
// Reports Module - Service
// ============================================================================

import { prisma } from "@/database/client.js";
import { Prisma } from "@/generated/prisma/client.js";
import type {
  ReportQuery,
  FinancialReportResponse,
  FinancialSummary,
  CurrencySummary,
  PaymentStatusBreakdownItem,
  AccessBreakdownItem,
  DailyTrendItem,
  ExportQuery,
} from "./reports.schema.js";

// ============================================================================
// Financial Report
// ============================================================================

interface DateRange {
  startDate: Date | null;
  endDate: Date | null;
}

function buildDateFilter(query: ReportQuery): DateRange {
  return {
    startDate: query.startDate ? new Date(query.startDate) : null,
    endDate: query.endDate ? new Date(query.endDate) : null,
  };
}

export async function getFinancialReport(
  eventId: string,
  query: ReportQuery,
): Promise<FinancialReportResponse> {
  const dateRange = buildDateFilter(query);

  // Build where clause for date filtering
  const dateWhere = {
    ...(dateRange.startDate && { submittedAt: { gte: dateRange.startDate } }),
    ...(dateRange.endDate && {
      submittedAt: {
        ...(dateRange.startDate ? { gte: dateRange.startDate } : {}),
        lte: dateRange.endDate,
      },
    }),
  };

  const baseWhere = {
    eventId,
    ...dateWhere,
  };

  // Run all aggregation queries in parallel
  const [summary, byPaymentStatus, byAccessType, dailyTrend] =
    await Promise.all([
      getFinancialSummary(baseWhere),
      getPaymentStatusBreakdown(baseWhere),
      getAccessBreakdown(eventId, dateRange),
      getDailyTrend(eventId, dateRange),
    ]);

  return {
    eventId,
    generatedAt: new Date().toISOString(),
    dateRange: {
      startDate: dateRange.startDate?.toISOString() ?? null,
      endDate: dateRange.endDate?.toISOString() ?? null,
    },
    summary,
    byPaymentStatus,
    byAccessType,
    dailyTrend,
  };
}

// ============================================================================
// Summary Aggregation
// ============================================================================

async function fetchCurrencyAggregations(where: Record<string, unknown>) {
  const [byCurrency, pendingByCurrency, refundedByCurrency, waivedByCurrency] =
    await Promise.all([
      prisma.registration.groupBy({
        by: ["currency"],
        where,
        _sum: {
          totalAmount: true,
          paidAmount: true,
          baseAmount: true,
          accessAmount: true,
          discountAmount: true,
          sponsorshipAmount: true,
        },
        _count: true,
      }),
      prisma.registration.groupBy({
        by: ["currency"],
        where: { ...where, paymentStatus: "PENDING" },
        _sum: { totalAmount: true, paidAmount: true },
      }),
      prisma.registration.groupBy({
        by: ["currency"],
        where: { ...where, paymentStatus: "REFUNDED" },
        _sum: { totalAmount: true },
      }),
      prisma.registration.groupBy({
        by: ["currency"],
        where: { ...where, paymentStatus: "WAIVED" },
        _sum: { totalAmount: true },
        _count: true,
      }),
    ]);
  return { byCurrency, pendingByCurrency, refundedByCurrency, waivedByCurrency };
}

type CurrencyAggregations = Awaited<ReturnType<typeof fetchCurrencyAggregations>>;

function buildCurrencySummaries(agg: CurrencyAggregations) {
  const { byCurrency, pendingByCurrency, refundedByCurrency, waivedByCurrency } = agg;

  const pendingMap = new Map(
    pendingByCurrency.map((p) => [
      p.currency,
      (p._sum.totalAmount ?? 0) - (p._sum.paidAmount ?? 0),
    ]),
  );
  const refundedMap = new Map(
    refundedByCurrency.map((r) => [r.currency, r._sum.totalAmount ?? 0]),
  );
  const waivedMap = new Map(
    waivedByCurrency.map((w) => [
      w.currency,
      { amount: w._sum.totalAmount ?? 0, count: w._count },
    ]),
  );

  const currencies: CurrencySummary[] = byCurrency.map((c) => ({
    currency: c.currency,
    totalRevenue: c._sum.paidAmount ?? 0,
    totalPending: pendingMap.get(c.currency) ?? 0,
    totalRefunded: refundedMap.get(c.currency) ?? 0,
    totalWaived: waivedMap.get(c.currency)?.amount ?? 0,
    waivedCount: waivedMap.get(c.currency)?.count ?? 0,
    registrationCount: c._count,
    breakdown: {
      base: c._sum.baseAmount ?? 0,
      access: c._sum.accessAmount ?? 0,
      discount: c._sum.discountAmount ?? 0,
      sponsorship: c._sum.sponsorshipAmount ?? 0,
    },
  }));

  const totals = {
    totalRevenue: currencies.reduce((sum, c) => sum + c.totalRevenue, 0),
    totalPending: currencies.reduce((sum, c) => sum + c.totalPending, 0),
    totalRefunded: currencies.reduce((sum, c) => sum + c.totalRefunded, 0),
    totalWaived: currencies.reduce((sum, c) => sum + c.totalWaived, 0),
    waivedCount: currencies.reduce((sum, c) => sum + c.waivedCount, 0),
    registrationCount: currencies.reduce((sum, c) => sum + c.registrationCount, 0),
    totalBase: currencies.reduce((sum, c) => sum + c.breakdown.base, 0),
    totalAccess: currencies.reduce((sum, c) => sum + c.breakdown.access, 0),
    totalDiscount: currencies.reduce((sum, c) => sum + c.breakdown.discount, 0),
    totalSponsorship: currencies.reduce((sum, c) => sum + c.breakdown.sponsorship, 0),
  };

  const averageRegistrationValue =
    totals.registrationCount > 0
      ? Math.round(
          byCurrency.reduce((sum, c) => sum + (c._sum.totalAmount ?? 0), 0) /
            totals.registrationCount,
        )
      : 0;

  const primaryCurrency =
    currencies.length > 0
      ? currencies.reduce((prev, curr) =>
          curr.registrationCount > prev.registrationCount ? curr : prev,
        ).currency
      : "TND";

  return { currencies, totals, averageRegistrationValue, primaryCurrency };
}

async function getFinancialSummary(
  where: Record<string, unknown>,
): Promise<FinancialSummary> {
  const agg = await fetchCurrencyAggregations(where);
  const { currencies, totals, averageRegistrationValue, primaryCurrency } =
    buildCurrencySummaries(agg);

  return {
    totalRevenue: totals.totalRevenue,
    totalPending: totals.totalPending,
    totalRefunded: totals.totalRefunded,
    totalWaived: totals.totalWaived,
    waivedCount: totals.waivedCount,
    averageRegistrationValue,
    baseRevenue: totals.totalBase,
    accessRevenue: totals.totalAccess,
    discountsGiven: totals.totalDiscount,
    sponsorshipsApplied: totals.totalSponsorship,
    registrationCount: totals.registrationCount,
    primaryCurrency,
    currencies,
  };
}

// ============================================================================
// Payment Status Breakdown
// ============================================================================

async function getPaymentStatusBreakdown(
  where: Record<string, unknown>,
): Promise<PaymentStatusBreakdownItem[]> {
  const groups = await prisma.registration.groupBy({
    by: ["paymentStatus"],
    where,
    _count: true,
    _sum: {
      totalAmount: true,
    },
  });

  return groups.map((g) => ({
    paymentStatus: g.paymentStatus,
    count: g._count,
    totalAmount: g._sum.totalAmount ?? 0,
  }));
}

// ============================================================================
// Access Type Breakdown
// ============================================================================

async function getAccessBreakdown(
  eventId: string,
  dateRange: DateRange,
): Promise<AccessBreakdownItem[]> {
  // Build the query with optional date conditions
  const startDateCondition = dateRange.startDate
    ? Prisma.sql`AND r.submitted_at >= ${dateRange.startDate}`
    : Prisma.empty;
  const endDateCondition = dateRange.endDate
    ? Prisma.sql`AND r.submitted_at <= ${dateRange.endDate}`
    : Prisma.empty;

  // Query access breakdown from priceBreakdown JSON using raw SQL
  // This unnests the accessItems array from priceBreakdown JSON
  const accessData = await prisma.$queryRaw<
    { access_id: string; count: bigint; total_amount: bigint }[]
  >(Prisma.sql`
    SELECT
      (item->>'accessId')::TEXT AS access_id,
      COUNT(*) AS count,
      COALESCE(SUM((item->>'subtotal')::INTEGER), 0) AS total_amount
    FROM registrations r,
    LATERAL jsonb_array_elements(r.price_breakdown->'accessItems') AS item
    WHERE r.event_id = ${eventId}
      AND jsonb_array_length(COALESCE(r.price_breakdown->'accessItems', '[]'::jsonb)) > 0
      ${startDateCondition}
      ${endDateCondition}
    GROUP BY (item->>'accessId')::TEXT
  `);

  // Get access names
  const accessIds = accessData.map((a) => a.access_id);
  if (accessIds.length === 0) return [];

  const accessItems = await prisma.eventAccess.findMany({
    where: { id: { in: accessIds } },
    select: {
      id: true,
      name: true,
      type: true,
    },
  });

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

// ============================================================================
// Daily Trend
// ============================================================================

async function getDailyTrend(
  eventId: string,
  dateRange: DateRange,
): Promise<DailyTrendItem[]> {
  // Default to last 30 days if no range provided
  const endDate = dateRange.endDate ?? new Date();
  const startDate =
    dateRange.startDate ??
    new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Use raw query for date grouping (Prisma doesn't support DATE() grouping natively)
  const results = await prisma.$queryRaw<
    { date: Date; count: bigint; total_amount: bigint }[]
  >`
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
  `;

  return results.map((r) => ({
    date: r.date.toISOString().split("T")[0],
    count: Number(r.count),
    totalAmount: Number(r.total_amount),
  }));
}

// ============================================================================
// CSV Export
// ============================================================================

type FormField = { id: string; label: string; type: string };

async function fetchFormFieldDefinitions(eventId: string): Promise<FormField[]> {
  const form = await prisma.form.findFirst({
    where: { eventId, type: "REGISTRATION" },
    select: { schema: true },
  });
  type FormSchemaSteps = {
    steps: Array<{ fields: Array<FormField> }>;
  };
  const formSchema = form?.schema as FormSchemaSteps | null;
  return (
    formSchema?.steps
      .flatMap((s) => s.fields)
      .filter((f) => !["heading", "paragraph"].includes(f.type)) ?? []
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildAccessNameMap(registrations: any[]): Promise<Map<string, string>> {
  const allAccessIds = Array.from(
    new Set(registrations.flatMap((r) => r.accessTypeIds as string[])),
  );
  const accessItems = await prisma.eventAccess.findMany({
    where: { id: { in: allAccessIds } },
    select: { id: true, name: true },
  });
  return new Map(accessItems.map((a) => [a.id, a.name]));
}

export async function exportRegistrations(
  eventId: string,
  eventSlug: string,
  query: ExportQuery,
): Promise<{
  filename: string;
  contentType: string;
  data: string;
  metadata: { total: number; exported: number; truncated: boolean };
}> {
  const dateRange = buildDateFilter(query);

  const where: Record<string, unknown> = { eventId };
  if (dateRange.startDate) {
    where.submittedAt = { gte: dateRange.startDate };
  }
  if (dateRange.endDate) {
    where.submittedAt = {
      ...(where.submittedAt as Record<string, Date> | undefined),
      lte: dateRange.endDate,
    };
  }

  const formFields = await fetchFormFieldDefinitions(eventId);

  const [registrations, total] = await Promise.all([
    prisma.registration.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        paymentStatus: true,
        paymentMethod: true,
        totalAmount: true,
        paidAmount: true,
        baseAmount: true,
        accessAmount: true,
        discountAmount: true,
        sponsorshipCode: true,
        sponsorshipAmount: true,
        submittedAt: true,
        paidAt: true,
        formData: true,
        accessTypeIds: true,
        priceBreakdown: true,
        currency: true,
      },
      orderBy: { submittedAt: "desc" },
      take: query.limit,
    }),
    prisma.registration.count({ where }),
  ]);

  const accessNameMap = await buildAccessNameMap(registrations);

  const timestamp = new Date().toISOString().split("T")[0];
  const filename = `${eventSlug}-registrations-${timestamp}`;
  const metadata = {
    total,
    exported: registrations.length,
    truncated: registrations.length < total,
  };

  if (query.format === "json") {
    return {
      filename: `${filename}.json`,
      contentType: "application/json",
      data: JSON.stringify(registrations, null, 2),
      metadata,
    };
  }

  const csv = generateCSV(registrations, formFields, accessNameMap);
  return { filename: `${filename}.csv`, contentType: "text/csv", data: csv, metadata };
}

function generateCSV(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registrations: any[],
  formFields: Array<{ id: string; label: string; type: string }>,
  accessNameMap: Map<string, string>,
): string {
  // Build headers: static + form fields + access types
  const staticHeaders = [
    "ID",
    "Email",
    "First Name",
    "Last Name",
    "Phone",
    "Payment Status",
    "Payment Method",
    "Total Amount",
    "Paid Amount",
    "Base Amount",
    "Access Amount",
    "Discount Amount",
    "Sponsorship Code",
    "Sponsorship Amount",
    "Submitted At",
    "Paid At",
  ];

  const formFieldHeaders = formFields.map((f) => f.label);
  const headers = [...staticHeaders, ...formFieldHeaders, "Access Types"];

  const rows = registrations.map((r) => {
    // Static columns
    const staticValues = [
      r.id,
      r.email,
      r.firstName ?? "",
      r.lastName ?? "",
      r.phone ?? "",
      r.paymentStatus,
      r.paymentMethod ?? "",
      r.totalAmount.toString(),
      r.paidAmount.toString(),
      r.baseAmount.toString(),
      r.accessAmount.toString(),
      r.discountAmount.toString(),
      r.sponsorshipCode ?? "",
      r.sponsorshipAmount.toString(),
      r.submittedAt.toISOString(),
      r.paidAt?.toISOString() ?? "",
    ];

    // Form data values
    const formData = (r.formData as Record<string, unknown>) ?? {};
    const formValues = formFields.map((field) => {
      const value = formData[field.id];
      if (value === null || value === undefined) return "";
      if (Array.isArray(value)) return value.join(", ");
      return String(value);
    });

    // Access types
    const accessIds = (r.accessTypeIds as string[]) ?? [];
    const accessNames = accessIds
      .map((id) => accessNameMap.get(id) ?? id)
      .join(", ");

    return [...staticValues, ...formValues, accessNames];
  });

  // Escape CSV values and neutralize formula injection
  const escapeCSV = (value: string): string => {
    let safe = value;
    if (/^[=+\-@\t\r]/.test(safe)) {
      safe = "'" + safe;
    }
    if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
      return `"${safe.replace(/"/g, '""')}"`;
    }
    return safe;
  };

  const csvLines = [
    headers.join(","),
    ...rows.map((row) => row.map(escapeCSV).join(",")),
  ];

  return csvLines.join("\n");
}
