import { describe, it, expect, beforeEach, vi } from "vitest";
import ExcelJS from "exceljs";
import { ErrorCodes } from "@app/contracts";

// Mock the db query layer (the seam the service talks to). All reports db fns
// are read-only fetches; the service does the aggregation/formatting math we
// assert on here. We do NOT assert internal call order (the legacy test pinned
// Promise.all mock order — that was an implementation detail); we assert outputs.
// Export fetches run inside withExportStatementTimeout; the fake hands them a
// sentinel executor so tests can assert they received the export transaction.
const EXPORT_TX = vi.hoisted(() => ({ exportTransaction: true }));

vi.mock("@app/db", () => ({
  withExportStatementTimeout: vi.fn((fn: (tx: unknown) => unknown) => fn(EXPORT_TX)),
  // Financial
  getFinancialSummaryAggregates: vi.fn(),
  getPaymentStatusBreakdown: vi.fn(),
  getAccessBreakdown: vi.fn(),
  getDailyTrendRows: vi.fn(),
  // Analytics + drill-down
  getEventAnalyticsData: vi.fn(),
  getAccessRegistrantsData: vi.fn(),
  // CSV/JSON/XLSX export
  getEventSlug: vi.fn(),
  getRegistrationFormDataKeys: vi.fn(),
  iterateRegistrationsForExport: vi.fn(),
  // Pulled in transitively by the generators/builder (unused in these tests).
  getEventSummaryData: vi.fn(),
  getReportEventAndAccess: vi.fn(),
  iterateAccessRegistrantsForReport: vi.fn(),
  getSponsorshipsReportData: vi.fn(),
  iterateSponsorshipsForReport: vi.fn(),
  iterateCheckInReportRows: vi.fn(),
  iterateRegistrationsForModularExport: vi.fn(),
  getRegistrationTableColumns: vi.fn(),
  getEventAccessNames: vi.fn(),
  getEventSlugAndName: vi.fn(),
  getSponsorshipLabDetails: vi.fn(),
}));

import * as db from "@app/db";
import { PassThrough } from "node:stream";
import { ReportsService } from "./reports.service";
import type { ExportDownload } from "../../core/exports/stream-io";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;
const service = new ReportsService();

const emptyAggregates = {
  byCurrency: [],
  pendingByCurrency: [],
  refundedByCurrency: [],
  revenueByCurrency: [],
  overall: {
    totalAmount: 0,
    paidAmount: 0,
    baseAmount: 0,
    accessAmount: 0,
    discountAmount: 0,
    sponsorshipAmount: 0,
    avgTotalAmount: 0,
    count: 0,
  },
  overallRevenuePaid: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// getFinancialReport
// ============================================================================

describe("getFinancialReport", () => {
  const eventId = "evt-001";

  beforeEach(() => {
    m.getFinancialSummaryAggregates.mockResolvedValue(emptyAggregates);
    m.getPaymentStatusBreakdown.mockResolvedValue([]);
    m.getAccessBreakdown.mockResolvedValue([]);
    m.getDailyTrendRows.mockResolvedValue([]);
  });

  it("returns a report with empty results when no registrations exist", async () => {
    const result = await service.getFinancialReport(eventId, {});

    expect(result.eventId).toBe(eventId);
    expect(result.generatedAt).toBeDefined();
    expect(result.dateRange).toEqual({ startDate: null, endDate: null });
    expect(result.summary.registrationCount).toBe(0);
    expect(result.summary.totalRevenue).toBe(0);
    expect(result.summary.currencies).toEqual([]);
    expect(result.byPaymentStatus).toEqual([]);
    expect(result.byAccessType).toEqual([]);
    expect(result.dailyTrend).toEqual([]);
  });

  it("passes parsed date range into the db aggregate fetch", async () => {
    const startDate = "2025-01-01T00:00:00.000Z";
    const endDate = "2025-01-31T23:59:59.000Z";

    await service.getFinancialReport(eventId, { startDate, endDate });

    expect(m.getFinancialSummaryAggregates).toHaveBeenCalledWith(eventId, {
      startDate: new Date(startDate),
      endDate: new Date(endDate),
    });
    // And it is surfaced on the response dateRange as ISO strings.
    const result = await service.getFinancialReport(eventId, { startDate, endDate });
    expect(result.dateRange).toEqual({ startDate, endDate });
  });

  it("builds correct currency summaries from aggregated data", async () => {
    m.getFinancialSummaryAggregates.mockResolvedValue({
      byCurrency: [
        {
          currency: "TND",
          totalAmount: 1000,
          paidAmount: 800,
          baseAmount: 600,
          accessAmount: 200,
          discountAmount: 50,
          sponsorshipAmount: 100,
          count: 5,
        },
      ],
      pendingByCurrency: [{ currency: "TND", totalAmount: 300, paidAmount: 100 }],
      refundedByCurrency: [{ currency: "TND", totalAmount: 50 }],
      revenueByCurrency: [{ currency: "TND", paidAmount: 800 }],
      overall: {
        totalAmount: 1000,
        paidAmount: 800,
        baseAmount: 600,
        accessAmount: 200,
        discountAmount: 50,
        sponsorshipAmount: 100,
        avgTotalAmount: 200,
        count: 5,
      },
      overallRevenuePaid: 800,
    });

    const result = await service.getFinancialReport(eventId, {});

    expect(result.summary.totalRevenue).toBe(800);
    expect(result.summary.registrationCount).toBe(5);
    expect(result.summary.averageRegistrationValue).toBe(200);
    expect(result.summary.primaryCurrency).toBe("TND");
    expect(result.summary.currencies).toHaveLength(1);
    expect(result.summary.currencies[0]).toMatchObject({
      currency: "TND",
      totalRevenue: 800,
      totalPending: 200, // clamp(totalAmount 300 - paidAmount 100)
      totalRefunded: 50,
      registrationCount: 5,
    });
  });

  it("excludes refunded paid amounts from total revenue", async () => {
    m.getFinancialSummaryAggregates.mockResolvedValue({
      byCurrency: [
        {
          currency: "TND",
          totalAmount: 1500,
          paidAmount: 1500,
          baseAmount: 1500,
          accessAmount: 0,
          discountAmount: 0,
          sponsorshipAmount: 0,
          count: 2,
        },
      ],
      pendingByCurrency: [],
      refundedByCurrency: [{ currency: "TND", totalAmount: 500 }],
      revenueByCurrency: [{ currency: "TND", paidAmount: 1000 }],
      overall: {
        totalAmount: 1500,
        paidAmount: 1500,
        baseAmount: 1500,
        accessAmount: 0,
        discountAmount: 0,
        sponsorshipAmount: 0,
        avgTotalAmount: 750,
        count: 2,
      },
      overallRevenuePaid: 1000,
    });

    const result = await service.getFinancialReport(eventId, {});

    expect(result.summary.totalRevenue).toBe(1000);
    expect(result.summary.totalRefunded).toBe(500);
    expect(result.summary.currencies[0].totalRevenue).toBe(1000);
  });

  it("defaults primaryCurrency to TND when there are no registrations", async () => {
    const result = await service.getFinancialReport(eventId, {});
    expect(result.summary.primaryCurrency).toBe("TND");
  });

  it("maps payment status breakdown as a direct pass-through", async () => {
    m.getPaymentStatusBreakdown.mockResolvedValue([
      { paymentStatus: "PAID", count: 10, totalAmount: 5000 },
      { paymentStatus: "PENDING", count: 3, totalAmount: 900 },
    ]);

    const result = await service.getFinancialReport(eventId, {});

    expect(result.byPaymentStatus).toEqual([
      { paymentStatus: "PAID", count: 10, totalAmount: 5000 },
      { paymentStatus: "PENDING", count: 3, totalAmount: 900 },
    ]);
  });

  it("maps daily trend rows (Date -> YYYY-MM-DD)", async () => {
    m.getDailyTrendRows.mockResolvedValue([
      { date: new Date("2025-03-15"), count: 4, totalAmount: 2000 },
    ]);

    const result = await service.getFinancialReport(eventId, {});

    expect(result.dailyTrend).toEqual([
      { date: "2025-03-15", count: 4, totalAmount: 2000 },
    ]);
  });
});

// ============================================================================
// getEventAnalytics
// ============================================================================

describe("getEventAnalytics", () => {
  const eventId = "evt-002";

  const emptyAnalytics = {
    paymentsByStatus: [],
    paymentsByMethod: [],
    accessItems: [],
    sponsorshipsByStatus: [],
  };

  beforeEach(() => {
    m.getEventAnalyticsData.mockResolvedValue(emptyAnalytics);
  });

  it("returns zeroed analytics when no data exists", async () => {
    const result = await service.getEventAnalytics(eventId);

    expect(result.eventId).toBe(eventId);
    expect(result.registrations.total).toBe(0);
    expect(result.payments).toEqual({
      paid: 0,
      verifying: 0,
      pending: 0,
      partial: 0,
      sponsored: 0,
      waived: 0,
      refunded: 0,
    });
    expect(result.paymentMethods).toEqual({
      bankTransfer: 0,
      online: 0,
      cash: 0,
      labSponsorship: 0,
      unset: 0,
    });
    expect(result.accessItems).toEqual([]);
    expect(result.sponsorships.total).toBe(0);
  });

  it("aggregates payment statuses and methods (null method -> unset)", async () => {
    m.getEventAnalyticsData.mockResolvedValue({
      paymentsByStatus: [
        { paymentStatus: "PAID", count: 10 },
        { paymentStatus: "PENDING", count: 5 },
        { paymentStatus: "SPONSORED", count: 2 },
      ],
      paymentsByMethod: [
        { paymentMethod: "BANK_TRANSFER", count: 8 },
        { paymentMethod: null, count: 9 },
      ],
      accessItems: [],
      sponsorshipsByStatus: [],
    });

    const result = await service.getEventAnalytics(eventId);

    expect(result.registrations.total).toBe(17);
    expect(result.payments.paid).toBe(10);
    expect(result.payments.pending).toBe(5);
    expect(result.payments.sponsored).toBe(2);
    expect(result.payments.verifying).toBe(0);
    expect(result.paymentMethods.bankTransfer).toBe(8);
    expect(result.paymentMethods.unset).toBe(9);
  });

  it("computes fillPercentage for access items with capacity", async () => {
    m.getEventAnalyticsData.mockResolvedValue({
      ...emptyAnalytics,
      accessItems: [
        {
          id: "acc-1",
          name: "VIP",
          type: "WORKSHOP",
          registeredCount: 75,
          maxCapacity: 100,
        },
        {
          id: "acc-2",
          name: "General",
          type: "CONFERENCE",
          registeredCount: 50,
          maxCapacity: null,
        },
      ],
    });

    const result = await service.getEventAnalytics(eventId);

    expect(result.accessItems).toHaveLength(2);
    expect(result.accessItems[0]).toMatchObject({ id: "acc-1", name: "VIP", fillPercentage: 75 });
    expect(result.accessItems[1]).toMatchObject({
      id: "acc-2",
      name: "General",
      fillPercentage: null,
    });
  });

  it("returns fillPercentage null when maxCapacity is zero", async () => {
    m.getEventAnalyticsData.mockResolvedValue({
      ...emptyAnalytics,
      accessItems: [
        {
          id: "acc-3",
          name: "Free",
          type: "OTHER",
          registeredCount: 10,
          maxCapacity: 0,
        },
      ],
    });

    const result = await service.getEventAnalytics(eventId);
    expect(result.accessItems[0].fillPercentage).toBeNull();
  });

  it("aggregates sponsorship statuses", async () => {
    m.getEventAnalyticsData.mockResolvedValue({
      ...emptyAnalytics,
      sponsorshipsByStatus: [
        { status: "APPROVED", count: 3 },
        { status: "PENDING", count: 7 },
      ],
    });

    const result = await service.getEventAnalytics(eventId);

    expect(result.sponsorships.total).toBe(10);
    expect(result.sponsorships.byStatus).toEqual([
      { status: "APPROVED", count: 3 },
      { status: "PENDING", count: 7 },
    ]);
  });
});

// ============================================================================
// exportRegistrations
// ============================================================================

/** Runs a prepared download into memory. */
async function collect(download: ExportDownload): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => out.on("end", resolve));
  await download.write(out, new AbortController().signal);
  await ended;
  return Buffer.concat(chunks);
}

const text = async (download: ExportDownload) => (await collect(download)).toString("utf8");

/**
 * Serves `rows` like the db would: pages of `pageSize` from the keyset
 * iterator, and the sorted union of their form_data keys.
 */
function mockExportRows(rows: Record<string, unknown>[], pageSize = 2) {
  m.iterateRegistrationsForExport.mockImplementation(async function* () {
    for (let i = 0; i < rows.length; i += pageSize) yield rows.slice(i, i + pageSize);
  });
  const keys = new Set<string>();
  for (const row of rows) {
    const fd = row.formData;
    if (fd && typeof fd === "object" && !Array.isArray(fd)) {
      for (const key of Object.keys(fd)) keys.add(key);
    }
  }
  m.getRegistrationFormDataKeys.mockResolvedValue([...keys].sort());
}

describe("exportRegistrations", () => {
  const eventId = "evt-003";

  it("throws 404 when the event does not exist", async () => {
    m.getEventSlug.mockResolvedValue(null);

    await expect(
      service.exportRegistrations(eventId, { format: "csv" }),
    ).rejects.toMatchObject({ statusCode: 404, code: ErrorCodes.NOT_FOUND });
  });

  it("exports as JSON when format is json", async () => {
    m.getEventSlug.mockResolvedValue({ slug: "my-event" });
    mockExportRows([]);

    const result = await service.exportRegistrations(eventId, { format: "json" });

    expect(result.filename).toMatch(/^my-event-registrations-.*\.json$/);
    expect(result.contentType).toBe("application/json");
    expect(await text(result)).toBe("[]");
    // JSON has no header: the key union is not read.
    expect(m.getRegistrationFormDataKeys).not.toHaveBeenCalled();
  });

  it("streams JSON across pages byte-for-byte like JSON.stringify(rows, null, 2)", async () => {
    m.getEventSlug.mockResolvedValue({ slug: "my-event" });
    const rows = [
      baseRow({ id: "r-1", submittedAt: new Date("2025-06-03T00:00:00Z"), formData: { a: { b: [1, "x\ny"] } } }),
      baseRow({ id: "r-2", submittedAt: new Date("2025-06-02T00:00:00Z"), paidAt: new Date("2025-06-02T01:00:00Z") }),
      baseRow({ id: "r-3", submittedAt: new Date("2025-06-01T00:00:00Z"), formData: [] }),
    ];
    mockExportRows(rows);

    const result = await service.exportRegistrations(eventId, { format: "json" });

    expect(await text(result)).toBe(JSON.stringify(rows, null, 2));
  });

  it("exports CSV with correct headers and data (incl. dynamic formData key)", async () => {
    m.getEventSlug.mockResolvedValue({ slug: "test-event" });
    mockExportRows([
      {
        id: "reg-1",
        email: "test@example.com",
        firstName: "John",
        lastName: "Doe",
        phone: "+216555",
        paymentStatus: "PAID",
        paymentMethod: "CASH",
        totalAmount: 500,
        paidAmount: 500,
        baseAmount: 400,
        accessAmount: 100,
        discountAmount: 0,
        sponsorshipCode: null,
        sponsorshipAmount: 0,
        submittedAt: new Date("2025-06-01T10:00:00Z"),
        paidAt: new Date("2025-06-01T12:00:00Z"),
        formData: { company: "Acme" },
      },
    ]);

    const result = await service.exportRegistrations(eventId, { format: "csv" });

    expect(result.filename).toMatch(/^test-event-registrations-.*\.csv$/);
    expect(result.contentType).toBe("text/csv; charset=utf-8");

    const lines = (await text(result)).split("\r\n");
    expect(lines[0]!.startsWith('\uFEFF"ID"')).toBe(true);
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("Email");
    expect(lines[0]).toContain("company");
    expect(lines[1]).toContain("reg-1");
    expect(lines[1]).toContain("test@example.com");
    expect(lines[1]).toContain("Acme");
    // Amounts stay numbers; the submission time is the ISO instant.
    expect(lines[1]).toContain('"500","500","400","100","0"');
    expect(lines[1]).toContain('"2025-06-01T10:00:00.000Z"');
  });

  it("guards CSV cells against formulas, including after leading spaces", async () => {
    m.getEventSlug.mockResolvedValue({ slug: "evt" });
    mockExportRows([
      baseRow({ id: "r-1", firstName: " =cmd|' /C calc'!A0", lastName: "-5+1", formData: { note: "@x" } }),
    ]);

    const result = await service.exportRegistrations(eventId, { format: "csv" });
    const row = (await text(result)).split("\r\n")[1]!;

    expect(row).toContain(`"' =cmd|' /C calc'!A0"`);
    expect(row).toContain(`"'-5+1"`);
    expect(row).toContain(`"'@x"`);
  });

  it("collects the alphabetical union of dynamic formData keys across rows", async () => {
    m.getEventSlug.mockResolvedValue({ slug: "evt" });
    mockExportRows([
      baseRow({ id: "r-1", email: "a@b.com", formData: { city: "Tunis" } }),
      baseRow({
        id: "r-2",
        email: "c@d.com",
        paymentStatus: "PENDING",
        formData: { specialty: "Cardiology" },
      }),
    ]);

    const result = await service.exportRegistrations(eventId, { format: "csv" });
    const [header, first, second] = (await text(result)).split("\r\n");

    expect(header).toContain('"city","specialty"');
    expect(first).toMatch(/"Tunis",""$/);
    expect(second).toMatch(/"","Cardiology"$/);
  });

  it("propagates the filters to the key union and the keyset pages", async () => {
    m.getEventSlug.mockResolvedValue({ slug: "evt" });
    mockExportRows([]);

    const result = await service.exportRegistrations(eventId, {
      format: "csv",
      search: "Mehdi",
      startDate: "2025-01-01T00:00:00.000Z",
      endDate: "2025-01-31T23:59:59.000Z",
    });
    const filters = expect.objectContaining({
      search: "Mehdi",
      startDate: "2025-01-01T00:00:00.000Z",
      endDate: "2025-01-31T23:59:59.000Z",
    });

    expect(m.getEventSlug).toHaveBeenCalledWith(eventId, EXPORT_TX);
    expect(m.getRegistrationFormDataKeys).toHaveBeenCalledWith(eventId, filters, EXPORT_TX);
    // Rows are read only once the download is written, page by page.
    expect(m.iterateRegistrationsForExport).not.toHaveBeenCalled();
    await collect(result);
    expect(m.iterateRegistrationsForExport).toHaveBeenCalledWith(
      eventId,
      filters,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("writes formula-like text to XLSX as plain text cells (no apostrophe prefix)", async () => {
    m.getEventSlug.mockResolvedValue({ slug: "evt" });
    mockExportRows([
      baseRow({
        id: "r-1",
        email: "a@b.com",
        firstName: '=HYPERLINK("https://evil.test")',
        lastName: "+Injected",
        submittedAt: new Date("2025-01-01T00:00:00Z"),
        formData: { note: "@cmd" },
      }),
    ]);

    const result = await service.exportRegistrations(eventId, { format: "xlsx" });
    const workbook = new ExcelJS.Workbook();
    const buffer = await collect(result);
    const workbookData = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(workbookData);
    const sheet = workbook.getWorksheet("Registrations")!;

    // A string cell is never evaluated, so the text is kept exactly as entered.
    expect(sheet.getCell("C2").value).toBe('=HYPERLINK("https://evil.test")');
    expect(sheet.getCell("C2").type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell("D2").value).toBe("+Injected");
    // 16 standard columns + 1st dynamic formData key ("note") => column Q.
    expect(sheet.getCell("Q2").value).toBe("@cmd");
    expect(sheet.getCell("Q2").type).toBe(ExcelJS.ValueType.String);
  });
});

// Minimal export row factory (fields the CSV/XLSX generators read).
function baseRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "r",
    email: "x@y.com",
    firstName: null,
    lastName: null,
    phone: null,
    paymentStatus: "PAID",
    paymentMethod: null,
    totalAmount: 0,
    paidAmount: 0,
    baseAmount: 0,
    accessAmount: 0,
    discountAmount: 0,
    sponsorshipCode: null,
    sponsorshipAmount: 0,
    submittedAt: new Date(),
    paidAt: null,
    formData: {},
    ...over,
  };
}

// ============================================================================
// getAccessRegistrants
// ============================================================================

describe("getAccessRegistrants", () => {
  it("throws 404 when the access item is not found (scoped to the event)", async () => {
    m.getAccessRegistrantsData.mockResolvedValue({ access: null, registrations: [] });

    await expect(
      service.getAccessRegistrants("event-1", "foreign-access"),
    ).rejects.toMatchObject({ statusCode: 404, code: ErrorCodes.ACCESS_NOT_FOUND });

    expect(m.getAccessRegistrantsData).toHaveBeenCalledWith("event-1", "foreign-access");
  });

  it("partitions registrants into settled / not-settled lists", async () => {
    m.getAccessRegistrantsData.mockResolvedValue({
      access: { name: "VIP", type: "WORKSHOP" },
      registrations: [
        {
          id: "r-1",
          firstName: "A",
          lastName: "B",
          email: "a@b.com",
          phone: null,
          paymentStatus: "PAID",
          paidAmount: 100,
          totalAmount: 100,
          currency: "TND",
          submittedAt: new Date("2025-01-01T00:00:00Z"),
        },
        {
          id: "r-2",
          firstName: "C",
          lastName: "D",
          email: "c@d.com",
          phone: null,
          paymentStatus: "PENDING",
          paidAmount: 0,
          totalAmount: 100,
          currency: "TND",
          submittedAt: new Date("2025-01-02T00:00:00Z"),
        },
      ],
    });

    const result = await service.getAccessRegistrants("event-1", "acc-1");

    expect(result).toMatchObject({
      accessId: "acc-1",
      accessName: "VIP",
      accessType: "WORKSHOP",
      total: 2,
      settled: 1,
      notSettled: 1,
    });
    expect(result.settledList[0].id).toBe("r-1");
    expect(result.settledList[0].submittedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(result.notSettledList[0].id).toBe("r-2");
  });
});
