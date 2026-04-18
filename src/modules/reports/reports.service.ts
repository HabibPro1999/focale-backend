// ============================================================================
// Reports Module - Service
// ============================================================================

import { prisma } from "@/database/client.js";
import { Prisma } from "@/generated/prisma/client.js";
import ExcelJS from "exceljs";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { buildRegistrationWhere } from "@registrations";
import type {
  ReportQuery,
  FinancialReportResponse,
  FinancialSummary,
  CurrencySummary,
  PaymentStatusBreakdownItem,
  AccessBreakdownItem,
  DailyTrendItem,
  ExportRegistrationsQuery,
} from "./reports.schema.js";
import type {
  EventAnalyticsResponse,
  AccessRegistrantsResponse,
} from "./analytics.schemas.js";

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

async function getFinancialSummary(
  where: Record<string, unknown>,
): Promise<FinancialSummary> {
  // Group by currency for accurate multi-currency reporting
  const byCurrency = await prisma.registration.groupBy({
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
  });

  // Get pending amounts by currency (includes VERIFYING — money not yet confirmed)
  const pendingByCurrency = await prisma.registration.groupBy({
    by: ["currency"],
    where: {
      ...where,
      paymentStatus: { in: ["PENDING", "VERIFYING", "PARTIAL"] },
    },
    _sum: {
      totalAmount: true,
      paidAmount: true,
    },
  });

  // Get refunded amounts by currency
  const refundedByCurrency = await prisma.registration.groupBy({
    by: ["currency"],
    where: {
      ...where,
      paymentStatus: "REFUNDED",
    },
    _sum: {
      totalAmount: true,
    },
  });

  // Build currency summaries
  const pendingMap = new Map(
    pendingByCurrency.map((p) => [
      p.currency,
      (p._sum.totalAmount ?? 0) - (p._sum.paidAmount ?? 0),
    ]),
  );
  const refundedMap = new Map(
    refundedByCurrency.map((r) => [r.currency, r._sum.totalAmount ?? 0]),
  );

  const currencies: CurrencySummary[] = byCurrency.map((c) => ({
    currency: c.currency,
    totalRevenue: c._sum.paidAmount ?? 0,
    totalPending: pendingMap.get(c.currency) ?? 0,
    totalRefunded: refundedMap.get(c.currency) ?? 0,
    registrationCount: c._count,
    breakdown: {
      base: c._sum.baseAmount ?? 0,
      access: c._sum.accessAmount ?? 0,
      discount: c._sum.discountAmount ?? 0,
      sponsorship: c._sum.sponsorshipAmount ?? 0,
    },
  }));

  // Also get overall aggregation for backward compatibility
  const aggregation = await prisma.registration.aggregate({
    where,
    _sum: {
      totalAmount: true,
      paidAmount: true,
      baseAmount: true,
      accessAmount: true,
      discountAmount: true,
      sponsorshipAmount: true,
    },
    _avg: {
      totalAmount: true,
    },
    _count: true,
  });

  // Calculate total pending across all currencies
  const totalPending = currencies.reduce((sum, c) => sum + c.totalPending, 0);
  const totalRefunded = currencies.reduce((sum, c) => sum + c.totalRefunded, 0);

  // Determine primary currency (most registrations or first one)
  const primaryCurrency =
    currencies.length > 0
      ? currencies.reduce((prev, curr) =>
          curr.registrationCount > prev.registrationCount ? curr : prev,
        ).currency
      : "TND";

  return {
    totalRevenue: aggregation._sum.paidAmount ?? 0,
    totalPending,
    totalRefunded,
    averageRegistrationValue: Math.round(aggregation._avg.totalAmount ?? 0),
    baseRevenue: aggregation._sum.baseAmount ?? 0,
    accessRevenue: aggregation._sum.accessAmount ?? 0,
    discountsGiven: aggregation._sum.discountAmount ?? 0,
    sponsorshipsApplied: aggregation._sum.sponsorshipAmount ?? 0,
    registrationCount: aggregation._count,
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
// Analytics
// ============================================================================

export async function getEventAnalytics(
  eventId: string,
): Promise<EventAnalyticsResponse> {
  // Run all aggregation queries in parallel
  // Note: Registration has no separate status field — paymentStatus is the sole lifecycle status.
  const [
    paymentsByStatus,
    paymentsByMethod,
    accessItems,
    sponsorshipsByStatus,
  ] = await Promise.all([
    // Registration counts by payment status
    prisma.registration.groupBy({
      by: ["paymentStatus"],
      where: { eventId },
      _count: true,
    }),

    // Registration counts by payment method (includes null = not yet set)
    prisma.registration.groupBy({
      by: ["paymentMethod"],
      where: { eventId },
      _count: true,
    }),

    // Access items with capacity info (ordered by start time if available)
    prisma.eventAccess.findMany({
      where: { eventId },
      select: {
        id: true,
        name: true,
        type: true,
        registeredCount: true,
        maxCapacity: true,
      },
      orderBy: { startsAt: "asc" },
    }),

    // Sponsorship counts by status
    prisma.sponsorship.groupBy({
      by: ["status"],
      where: { eventId },
      _count: true,
    }),
  ]);

  // Build lookup from payment status groups
  const paymentMap = new Map(
    paymentsByStatus.map((g) => [g.paymentStatus, g._count]),
  );

  // Build lookup from payment method groups (paymentMethod is nullable)
  const methodMap = new Map(
    paymentsByMethod.map((g) => [g.paymentMethod ?? "UNSET", g._count]),
  );

  const registrationTotal = paymentsByStatus.reduce(
    (sum, g) => sum + g._count,
    0,
  );

  const sponsorshipTotal = sponsorshipsByStatus.reduce(
    (sum, g) => sum + g._count,
    0,
  );

  return {
    eventId,
    generatedAt: new Date().toISOString(),
    registrations: {
      total: registrationTotal,
    },
    payments: {
      paid: paymentMap.get("PAID") ?? 0,
      verifying: paymentMap.get("VERIFYING") ?? 0,
      pending: paymentMap.get("PENDING") ?? 0,
      partial: paymentMap.get("PARTIAL") ?? 0,
      sponsored: paymentMap.get("SPONSORED") ?? 0,
      waived: paymentMap.get("WAIVED") ?? 0,
      refunded: paymentMap.get("REFUNDED") ?? 0,
    },
    paymentMethods: {
      bankTransfer: methodMap.get("BANK_TRANSFER") ?? 0,
      online: methodMap.get("ONLINE") ?? 0,
      cash: methodMap.get("CASH") ?? 0,
      labSponsorship: methodMap.get("LAB_SPONSORSHIP") ?? 0,
      unset: methodMap.get("UNSET") ?? 0,
    },
    accessItems: accessItems.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      registeredCount: item.registeredCount,
      maxCapacity: item.maxCapacity,
      fillPercentage:
        item.maxCapacity && item.maxCapacity > 0
          ? Math.round((item.registeredCount / item.maxCapacity) * 100)
          : null,
    })),
    sponsorships: {
      total: sponsorshipTotal,
      byStatus: sponsorshipsByStatus.map((g) => ({
        status: g.status,
        count: g._count,
      })),
    },
  };
}

// ============================================================================
// Event Summary Report (Excel) — extracted to excel-generator.ts
// ============================================================================

export {
  generateEventSummary,
  generateAccessRegistrantsReport,
  generateSponsorshipsReport,
  generateCheckInReport,
} from "./excel-generator.js";

export { buildRegistrationsWorkbook } from "./registrations-export-builder.js";

// ============================================================================
// CSV Export
// ============================================================================

interface RegistrationExportRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  paymentStatus: string;
  paymentMethod: string | null;
  totalAmount: number;
  paidAmount: number;
  baseAmount: number;
  accessAmount: number;
  discountAmount: number;
  sponsorshipCode: string | null;
  sponsorshipAmount: number;
  submittedAt: Date;
  paidAt: Date | null;
  formData: unknown;
}

export async function exportRegistrations(
  eventId: string,
  query: ExportRegistrationsQuery,
): Promise<{ filename: string; contentType: string; data: string | Buffer }> {
  // Fail fast — verify event exists before querying registrations
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { slug: true },
  });

  if (!event) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }

  const dateRange = buildDateFilter(query);

  // Build where clause using shared helper + date range
  const where = buildRegistrationWhere(eventId, {
    paymentStatus: query.paymentStatus,
    paymentMethod: query.paymentMethod,
    search: query.search,
  });
  if (dateRange.startDate) {
    where.submittedAt = { gte: dateRange.startDate };
  }
  if (dateRange.endDate) {
    where.submittedAt = {
      ...(where.submittedAt as Record<string, Date> | undefined),
      lte: dateRange.endDate,
    };
  }

  // Fetch all registrations (including formData for export)
  const registrations = await prisma.registration.findMany({
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
    },
    orderBy: { submittedAt: "desc" },
  });

  const timestamp = new Date().toISOString().split("T")[0];
  const filename = `${event.slug}-registrations-${timestamp}`;

  if (query.format === "json") {
    return {
      filename: `${filename}.json`,
      contentType: "application/json",
      data: JSON.stringify(registrations, null, 2),
    };
  }

  if (query.format === "xlsx") {
    const workbook = await generateRegistrationsWorkbook(registrations);

    return {
      filename: `${filename}.xlsx`,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: Buffer.from(await workbook.xlsx.writeBuffer()),
    };
  }

  // Generate CSV
  const csv = generateCSV(registrations);

  return {
    filename: `${filename}.csv`,
    contentType: "text/csv",
    data: csv,
  };
}

function generateCSV(registrations: RegistrationExportRow[]): string {
  const standardHeaders = [
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

  const formDataKeys = extractRegistrationFormDataKeys(registrations);

  const headers = [...standardHeaders, ...formDataKeys];

  const rows = registrations.map((r) => {
    const standardValues = [
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

    // Extract formData values for each dynamic key
    const fd =
      r.formData && typeof r.formData === "object" && !Array.isArray(r.formData)
        ? (r.formData as Record<string, unknown>)
        : {};
    const formDataValues = formDataKeys.map((key) => {
      const value = fd[key];
      if (value == null) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    });

    return [...standardValues, ...formDataValues];
  });

  // Escape CSV values
  const escapeCSV = (value: string): string => {
    // Guard against CSV formula injection
    if (
      value.length > 0 &&
      ["\t", "\r", "\n", "=", "+", "-", "@"].includes(value[0])
    ) {
      return `"'${value.replace(/"/g, '""')}"`;
    }
    if (value.includes(",") || value.includes('"') || value.includes("\n")) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const csvLines = [
    headers.join(","),
    ...rows.map((row) => row.map(escapeCSV).join(",")),
  ];

  return csvLines.join("\n");
}

async function generateRegistrationsWorkbook(
  registrations: RegistrationExportRow[],
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Focale OS";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Registrations");

  const standardHeaders = [
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

  const formDataKeys = extractRegistrationFormDataKeys(registrations);
  const headers = [...standardHeaders, ...formDataKeys];

  const headerFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E79" },
  };
  const headerFont: Partial<ExcelJS.Font> = {
    bold: true,
    color: { argb: "FFFFFFFF" },
    size: 11,
  };
  const border: Partial<ExcelJS.Borders> = {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };

  const headerRow = sheet.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = border;
  });

  for (const registration of registrations) {
    const fd =
      registration.formData &&
      typeof registration.formData === "object" &&
      !Array.isArray(registration.formData)
        ? (registration.formData as Record<string, unknown>)
        : {};

    const row = sheet.addRow([
      registration.id,
      registration.email,
      registration.firstName ?? "",
      registration.lastName ?? "",
      registration.phone ?? "",
      registration.paymentStatus,
      registration.paymentMethod ?? "",
      registration.totalAmount,
      registration.paidAmount,
      registration.baseAmount,
      registration.accessAmount,
      registration.discountAmount,
      registration.sponsorshipCode ?? "",
      registration.sponsorshipAmount,
      registration.submittedAt.toISOString(),
      registration.paidAt?.toISOString() ?? "",
      ...formDataKeys.map((key) => {
        const value = fd[key];
        if (value == null) return "";
        if (typeof value === "object") return JSON.stringify(value);
        return String(value);
      }),
    ]);

    row.eachCell((cell) => {
      cell.border = border;
      cell.alignment = { vertical: "top", wrapText: true };
    });
  }

  sheet.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number, column: headers.length },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const moneyColumns = [8, 9, 10, 11, 12, 14];
  moneyColumns.forEach((columnNumber) => {
    sheet.getColumn(columnNumber).numFmt = "#,##0";
  });

  headers.forEach((header, index) => {
    const lowerHeader = header.toLowerCase();
    let width = 18;

    if (lowerHeader.includes("email")) width = 28;
    else if (lowerHeader.includes("name")) width = 20;
    else if (lowerHeader.includes("phone")) width = 18;
    else if (lowerHeader.includes("amount")) width = 14;
    else if (
      lowerHeader.includes("submitted") ||
      lowerHeader.includes("paid at")
    ) {
      width = 24;
    } else if (
      lowerHeader.includes("status") ||
      lowerHeader.includes("method")
    ) {
      width = 18;
    } else if (header === "ID") {
      width = 38;
    }

    sheet.getColumn(index + 1).width = width;
  });

  return workbook;
}

function extractRegistrationFormDataKeys(
  registrations: RegistrationExportRow[],
): string[] {
  const formDataKeysSet = new Set<string>();

  for (const registration of registrations) {
    if (
      registration.formData &&
      typeof registration.formData === "object" &&
      !Array.isArray(registration.formData)
    ) {
      for (const key of Object.keys(
        registration.formData as Record<string, unknown>,
      )) {
        formDataKeysSet.add(key);
      }
    }
  }

  return Array.from(formDataKeysSet).sort();
}

// ============================================================================
// Access Registrants Drill-Down
// ============================================================================

const SETTLED_STATUSES = ["PAID", "SPONSORED", "WAIVED"];

export async function getAccessRegistrants(
  eventId: string,
  accessId: string,
): Promise<AccessRegistrantsResponse> {
  const [access, registrations] = await Promise.all([
    prisma.eventAccess.findUnique({
      where: { id: accessId },
      select: { name: true, type: true },
    }),
    prisma.registration.findMany({
      where: {
        eventId,
        accessTypeIds: { has: accessId },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        paymentStatus: true,
        paidAmount: true,
        totalAmount: true,
        currency: true,
        submittedAt: true,
      },
      orderBy: { submittedAt: "desc" },
    }),
  ]);

  if (!access) {
    throw new AppError("Access item not found", 404, ErrorCodes.NOT_FOUND);
  }

  const mapRegistrant = (r: (typeof registrations)[number]) => ({
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    phone: r.phone,
    paymentStatus: r.paymentStatus,
    paidAmount: r.paidAmount,
    totalAmount: r.totalAmount,
    currency: r.currency,
    submittedAt: r.submittedAt.toISOString(),
  });

  const settledList = registrations
    .filter((r) => SETTLED_STATUSES.includes(r.paymentStatus))
    .map(mapRegistrant);
  const notSettledList = registrations
    .filter((r) => !SETTLED_STATUSES.includes(r.paymentStatus))
    .map(mapRegistrant);

  return {
    accessId,
    accessName: access.name,
    accessType: access.type,
    total: registrations.length,
    settled: settledList.length,
    notSettled: notSettledList.length,
    settledList,
    notSettledList,
  };
}
