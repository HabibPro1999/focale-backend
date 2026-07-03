// ============================================================================
// Reports Module - Service (read-only aggregation + file generation)
// ============================================================================

import { Injectable } from "@nestjs/common";
import ExcelJS from "exceljs";
import {
  getFinancialSummaryAggregates,
  getPaymentStatusBreakdown,
  getAccessBreakdown,
  getDailyTrendRows,
  getEventAnalyticsData,
  getAccessRegistrantsData,
  getEventSlug,
  getRegistrationsForExport,
  type DateRange,
  type FinancialSummaryAggregates,
  type ExportRegistrationRow,
} from "@app/db";
import { ErrorCodes } from "@app/contracts";
import type {
  ReportQuery,
  FinancialReportResponse,
  FinancialSummary,
  CurrencySummary,
  ExportRegistrationsQuery,
  EventAnalyticsResponse,
  AccessRegistrantsResponse,
  ExportRegistrationsBody,
} from "@app/contracts";
import { AppException } from "../../core/app-exception";
import { escapeExcelRow } from "./excel-safety";
import {
  generateEventSummary,
  generateAccessRegistrantsReport,
  generateSponsorshipsReport,
  generateCheckInReport,
} from "./excel-generator";
import { buildRegistrationsWorkbook } from "./registrations-export-builder";

function buildDateFilter(query: ReportQuery): DateRange {
  return {
    startDate: query.startDate ? new Date(query.startDate) : null,
    endDate: query.endDate ? new Date(query.endDate) : null,
  };
}

const SETTLED_STATUSES = ["PAID", "SPONSORED", "WAIVED"];

@Injectable()
export class ReportsService {
  // ==========================================================================
  // Financial report
  // ==========================================================================

  async getFinancialReport(
    eventId: string,
    query: ReportQuery,
  ): Promise<FinancialReportResponse> {
    const dateRange = buildDateFilter(query);

    const [aggregates, byPaymentStatus, byAccessType, dailyTrendRows] =
      await Promise.all([
        getFinancialSummaryAggregates(eventId, dateRange),
        getPaymentStatusBreakdown(eventId, dateRange),
        getAccessBreakdown(eventId, dateRange),
        getDailyTrendRows(eventId, dateRange),
      ]);

    return {
      eventId,
      generatedAt: new Date().toISOString(),
      dateRange: {
        startDate: dateRange.startDate?.toISOString() ?? null,
        endDate: dateRange.endDate?.toISOString() ?? null,
      },
      summary: buildFinancialSummary(aggregates),
      byPaymentStatus,
      byAccessType,
      dailyTrend: dailyTrendRows.map((r) => ({
        date: r.date.toISOString().split("T")[0],
        count: r.count,
        totalAmount: r.totalAmount,
      })),
    };
  }

  // ==========================================================================
  // Analytics
  // ==========================================================================

  async getEventAnalytics(eventId: string): Promise<EventAnalyticsResponse> {
    const { paymentsByStatus, paymentsByMethod, accessItems, sponsorshipsByStatus } =
      await getEventAnalyticsData(eventId);

    const paymentMap = new Map(paymentsByStatus.map((g) => [g.paymentStatus, g.count]));
    const methodMap = new Map(
      paymentsByMethod.map((g) => [g.paymentMethod ?? "UNSET", g.count]),
    );

    const registrationTotal = paymentsByStatus.reduce((sum, g) => sum + g.count, 0);
    const sponsorshipTotal = sponsorshipsByStatus.reduce((sum, g) => sum + g.count, 0);

    return {
      eventId,
      generatedAt: new Date().toISOString(),
      registrations: { total: registrationTotal },
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
          count: g.count,
        })),
      },
    };
  }

  // ==========================================================================
  // Access registrants drill-down
  // ==========================================================================

  async getAccessRegistrants(
    eventId: string,
    accessId: string,
  ): Promise<AccessRegistrantsResponse> {
    const { access, registrations } = await getAccessRegistrantsData(eventId, accessId);

    if (!access) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Access item not found", 404);
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

  // ==========================================================================
  // CSV / JSON / XLSX registrations export
  // ==========================================================================

  async exportRegistrations(
    eventId: string,
    query: ExportRegistrationsQuery,
  ): Promise<{ filename: string; contentType: string; data: string | Buffer }> {
    // Fail fast — verify event exists before querying registrations.
    const event = await getEventSlug(eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }

    const registrations = await getRegistrationsForExport(eventId, {
      paymentStatus: query.paymentStatus,
      paymentMethod: query.paymentMethod,
      search: query.search,
      startDate: query.startDate,
      endDate: query.endDate,
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

    const csv = generateCSV(registrations);
    return {
      filename: `${filename}.csv`,
      contentType: "text/csv",
      data: csv,
    };
  }

  // ==========================================================================
  // Excel/ZIP file endpoints — thin delegation to the generators.
  // ==========================================================================

  generateEventSummary(eventId: string): Promise<{ filename: string; data: Buffer }> {
    return generateEventSummary(eventId);
  }

  generateAccessRegistrantsReport(
    eventId: string,
  ): Promise<{ filename: string; data: Buffer }> {
    return generateAccessRegistrantsReport(eventId);
  }

  generateSponsorshipsReport(
    eventId: string,
    filters?: { status?: string; search?: string },
  ): Promise<{ filename: string; data: Buffer }> {
    return generateSponsorshipsReport(eventId, filters);
  }

  generateCheckInReport(eventId: string): Promise<{ filename: string; data: Buffer }> {
    return generateCheckInReport(eventId);
  }

  buildRegistrationsWorkbook(
    eventId: string,
    body: ExportRegistrationsBody,
  ): Promise<{ filename: string; data: Buffer }> {
    return buildRegistrationsWorkbook(eventId, body);
  }
}

// ============================================================================
// Financial summary math (currency reduce, TND default, clamped pending)
// ============================================================================

function buildFinancialSummary(agg: FinancialSummaryAggregates): FinancialSummary {
  const pendingMap = new Map(
    agg.pendingByCurrency.map((p) => [p.currency, Math.max(0, p.totalAmount - p.paidAmount)]),
  );
  const refundedMap = new Map(agg.refundedByCurrency.map((r) => [r.currency, r.totalAmount]));
  const revenueMap = new Map(agg.revenueByCurrency.map((r) => [r.currency, r.paidAmount]));

  const currencies: CurrencySummary[] = agg.byCurrency.map((c) => ({
    currency: c.currency,
    totalRevenue: revenueMap.get(c.currency) ?? 0,
    totalPending: pendingMap.get(c.currency) ?? 0,
    totalRefunded: refundedMap.get(c.currency) ?? 0,
    registrationCount: c.count,
    breakdown: {
      base: c.baseAmount,
      access: c.accessAmount,
      discount: c.discountAmount,
      sponsorship: c.sponsorshipAmount,
    },
  }));

  const totalPending = currencies.reduce((sum, c) => sum + c.totalPending, 0);
  const totalRefunded = currencies.reduce((sum, c) => sum + c.totalRefunded, 0);

  const primaryCurrency =
    currencies.length > 0
      ? currencies.reduce((prev, curr) =>
          curr.registrationCount > prev.registrationCount ? curr : prev,
        ).currency
      : "TND";

  return {
    totalRevenue: agg.overallRevenuePaid,
    totalPending,
    totalRefunded,
    averageRegistrationValue: Math.round(agg.overall.avgTotalAmount),
    baseRevenue: agg.overall.baseAmount,
    accessRevenue: agg.overall.accessAmount,
    discountsGiven: agg.overall.discountAmount,
    sponsorshipsApplied: agg.overall.sponsorshipAmount,
    registrationCount: agg.overall.count,
    primaryCurrency,
    currencies,
  };
}

// ============================================================================
// CSV Export (standard headers + dynamic formData keys)
// ============================================================================

function generateCSV(registrations: ExportRegistrationRow[]): string {
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

  // Escape CSV values (formula-injection guard differs from the XLSX escaper).
  const escapeCSV = (value: string): string => {
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
  registrations: ExportRegistrationRow[],
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

  const headerRow = sheet.addRow(escapeExcelRow(headers));
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

    const row = sheet.addRow(
      escapeExcelRow([
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
      ]),
    );

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
    else if (lowerHeader.includes("submitted") || lowerHeader.includes("paid at")) {
      width = 24;
    } else if (lowerHeader.includes("status") || lowerHeader.includes("method")) {
      width = 18;
    } else if (header === "ID") {
      width = 38;
    }

    sheet.getColumn(index + 1).width = width;
  });

  return workbook;
}

function extractRegistrationFormDataKeys(
  registrations: ExportRegistrationRow[],
): string[] {
  const formDataKeysSet = new Set<string>();

  for (const registration of registrations) {
    if (
      registration.formData &&
      typeof registration.formData === "object" &&
      !Array.isArray(registration.formData)
    ) {
      for (const key of Object.keys(registration.formData as Record<string, unknown>)) {
        formDataKeysSet.add(key);
      }
    }
  }

  return Array.from(formDataKeysSet).sort();
}
