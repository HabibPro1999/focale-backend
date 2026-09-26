// ============================================================================
// Reports Module - Service (read-only aggregation + file generation)
// ============================================================================

import { Injectable } from "@nestjs/common";
import type ExcelJS from "exceljs";
import type { Writable } from "node:stream";
import {
  getFinancialSummaryAggregates,
  getPaymentStatusBreakdown,
  getAccessBreakdown,
  getDailyTrendRows,
  getEventAnalyticsData,
  getAccessRegistrantsData,
  getEventSlug,
  getRegistrationFormDataKeys,
  iterateRegistrationsForExport,
  withExportStatementTimeout,
  type DateRange,
  type FinancialSummaryAggregates,
  type ExportRegistrationRow,
} from "@app/db";
import { ErrorCodes } from "@app/contracts";
import { CSV_BOM, formatFileDate, isFullySettled, toCsvLine } from "@app/shared";
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
import {
  generateEventSummary,
  generateAccessRegistrantsReport,
  generateSponsorshipsReport,
  generateCheckInReport,
} from "./excel-generator";
import { prepareRegistrationsWorkbook } from "./registrations-export-builder";
import { writeChunk, type ExportDownload } from "../../core/exports/stream-io";
import {
  XLSX_CONTENT_TYPE,
  ColumnStyles,
  RowPacer,
  createXlsxWriter,
} from "../../core/exports/xlsx-stream";

function buildDateFilter(query: ReportQuery): DateRange {
  return {
    startDate: query.startDate ? new Date(query.startDate) : null,
    endDate: query.endDate ? new Date(query.endDate) : null,
  };
}

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
      .filter((r) => isFullySettled(r.paymentStatus))
      .map(mapRegistrant);
    const notSettledList = registrations
      .filter((r) => !isFullySettled(r.paymentStatus))
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

  /**
   * GET export. The event check and the form_data key union (the header) run
   * now; `write` streams the rows page by page in the requested format.
   */
  async exportRegistrations(
    eventId: string,
    query: ExportRegistrationsQuery,
  ): Promise<ExportDownload> {
    const filters = {
      paymentStatus: query.paymentStatus,
      paymentMethod: query.paymentMethod,
      search: query.search,
      startDate: query.startDate,
      endDate: query.endDate,
    };
    // Fail fast — verify the event exists before reading registrations.
    const { event, formDataKeys } = await withExportStatementTimeout(async (tx) => {
      const found = await getEventSlug(eventId, tx);
      if (!found) return { event: null, formDataKeys: [] };
      const keys =
        query.format === "json" ? [] : await getRegistrationFormDataKeys(eventId, filters, tx);
      return { event: found, formDataKeys: keys };
    });
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }

    const filename = `${event.slug}-registrations-${formatFileDate()}`;
    const pages = (signal: AbortSignal) =>
      iterateRegistrationsForExport(eventId, filters, { signal });

    if (query.format === "json") {
      return {
        filename: `${filename}.json`,
        contentType: "application/json",
        write: (out, signal) => writeRegistrationsJson(out, signal, pages(signal)),
      };
    }

    if (query.format === "xlsx") {
      return {
        filename: `${filename}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        write: (out, signal) =>
          writeRegistrationsXlsx(out, signal, formDataKeys, pages(signal)),
      };
    }

    return {
      filename: `${filename}.csv`,
      contentType: "text/csv; charset=utf-8",
      write: (out, signal) => writeRegistrationsCsv(out, signal, formDataKeys, pages(signal)),
    };
  }

  // ==========================================================================
  // Excel/ZIP file endpoints — thin delegation to the generators (still built
  // in memory; they stream from a buffer until 3.7b converts them).
  // ==========================================================================

  async generateEventSummary(eventId: string): Promise<ExportDownload> {
    const { filename, data } = await generateEventSummary(eventId);
    return bufferedDownload(filename, XLSX_CONTENT_TYPE, data);
  }

  async generateAccessRegistrantsReport(eventId: string): Promise<ExportDownload> {
    const { filename, data } = await generateAccessRegistrantsReport(eventId);
    return bufferedDownload(filename, XLSX_CONTENT_TYPE, data);
  }

  async generateSponsorshipsReport(
    eventId: string,
    filters?: { status?: string; search?: string },
  ): Promise<ExportDownload> {
    const { filename, data } = await generateSponsorshipsReport(eventId, filters);
    return bufferedDownload(filename, XLSX_CONTENT_TYPE, data);
  }

  async generateCheckInReport(eventId: string): Promise<ExportDownload> {
    const { filename, data } = await generateCheckInReport(eventId);
    return bufferedDownload(filename, "application/zip", data);
  }

  buildRegistrationsWorkbook(
    eventId: string,
    body: ExportRegistrationsBody,
  ): Promise<ExportDownload> {
    return prepareRegistrationsWorkbook(eventId, body);
  }
}

/** A file already built in memory, sent through the same download path. */
function bufferedDownload(filename: string, contentType: string, data: Buffer): ExportDownload {
  return {
    filename,
    contentType,
    write: async (out, signal) => {
      await writeChunk(out, data, signal);
      out.end();
    },
  };
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
// CSV / JSON / XLSX registrations export (streamed page by page)
// ============================================================================

const STANDARD_EXPORT_HEADERS = [
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

/** Standard values, then one cell per form_data key (objects as JSON). */
function exportRowValues(r: ExportRegistrationRow, formDataKeys: string[]): (string | number)[] {
  const fd =
    r.formData && typeof r.formData === "object" && !Array.isArray(r.formData)
      ? (r.formData as Record<string, unknown>)
      : {};
  return [
    r.id,
    r.email,
    r.firstName ?? "",
    r.lastName ?? "",
    r.phone ?? "",
    r.paymentStatus,
    r.paymentMethod ?? "",
    r.totalAmount,
    r.paidAmount,
    r.baseAmount,
    r.accessAmount,
    r.discountAmount,
    r.sponsorshipCode ?? "",
    r.sponsorshipAmount,
    r.submittedAt.toISOString(),
    r.paidAt?.toISOString() ?? "",
    ...formDataKeys.map((key) => {
      const value = fd[key];
      if (value == null) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }),
  ];
}

/** Shared CSV policy (quoted cells, formula guard, CRLF, UTF-8 BOM), one page per write. */
async function writeRegistrationsCsv(
  out: Writable,
  signal: AbortSignal,
  formDataKeys: string[],
  pages: AsyncIterable<ExportRegistrationRow[]>,
): Promise<void> {
  const pacer = new RowPacer(out, signal);
  await writeChunk(out, CSV_BOM + toCsvLine([...STANDARD_EXPORT_HEADERS, ...formDataKeys]), signal);
  for await (const page of pages) {
    let chunk = "";
    for (const r of page) chunk += toCsvLine(exportRowValues(r, formDataKeys));
    await writeChunk(out, chunk, signal);
    await pacer.pageDone();
  }
  out.end();
}

/** Byte-for-byte `JSON.stringify(rows, null, 2)`, written one page at a time. */
async function writeRegistrationsJson(
  out: Writable,
  signal: AbortSignal,
  pages: AsyncIterable<ExportRegistrationRow[]>,
): Promise<void> {
  const pacer = new RowPacer(out, signal);
  let first = true;
  for await (const page of pages) {
    let chunk = "";
    for (const r of page) {
      chunk += `${first ? "[\n" : ",\n"}  ${JSON.stringify(r, null, 2).replace(/\n/g, "\n  ")}`;
      first = false;
    }
    await writeChunk(out, chunk, signal);
    await pacer.pageDone();
  }
  await writeChunk(out, first ? "[]" : "\n]", signal);
  out.end();
}

async function writeRegistrationsXlsx(
  out: Writable,
  signal: AbortSignal,
  formDataKeys: string[],
  pages: AsyncIterable<ExportRegistrationRow[]>,
): Promise<void> {
  const workbook = createXlsxWriter(out, signal);
  const sheet = workbook.addWorksheet("Registrations", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const headers = [...STANDARD_EXPORT_HEADERS, ...formDataKeys];

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

  // Column widths and money formats go first: a streamed sheet writes its
  // column definitions with the first row, and new cells inherit the format.
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

  const headerRow = sheet.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = border;
  });
  headerRow.commit();
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  };

  const cellStyles = new ColumnStyles((column) => ({
    ...(moneyColumns.includes(column) ? { numFmt: "#,##0" } : {}),
    border,
    alignment: { vertical: "top", wrapText: true },
  }));
  const pacer = new RowPacer(out, signal, sheet);
  for await (const page of pages) {
    for (const registration of page) {
      const row = sheet.addRow(exportRowValues(registration, formDataKeys));
      row.eachCell((cell, colNumber) => {
        cell.style = cellStyles.for(colNumber, cell.type);
      });
      row.commit();
      await pacer.row();
    }
    await pacer.pageDone();
  }

  signal.throwIfAborted();
  sheet.commit();
  await workbook.commit();
}
