import { beforeEach, describe, expect, it, vi } from "vitest";

const exportTx = vi.hoisted(() => ({ exportTransaction: true }));
vi.mock("@app/db", () => ({
  withExportStatementTimeout: vi.fn((run: (tx: unknown) => unknown) => run(exportTx)),
  getRegistrationsForExport: vi.fn(),
  getFinancialSummaryAggregates: vi.fn(), getPaymentStatusBreakdown: vi.fn(), getAccessBreakdown: vi.fn(),
  getDailyTrendRows: vi.fn(), getEventAnalyticsData: vi.fn(), getAccessRegistrantsData: vi.fn(),
  getEventSummaryData: vi.fn(), getAccessRegistrantsReportData: vi.fn(), getSponsorshipsReportData: vi.fn(), getCheckInReportData: vi.fn(),
  getRegistrationsForModularExport: vi.fn(), getRegistrationTableColumns: vi.fn(), getEventAccessNames: vi.fn(),
  getEventSlugAndName: vi.fn(), getSponsorshipLabDetails: vi.fn(),
}));
import * as db from "@app/db";
import { ReportsService } from "./reports.service";
import { event, expectHeader, exportRegistration, readWorkbook, rowValues, useExportClock } from "../../../tests/reports/exports.test-support";

useExportClock();
const service = new ReportsService();
const headers = [
  "ID", "Email", "First Name", "Last Name", "Phone", "Payment Status", "Payment Method",
  "Total Amount", "Paid Amount", "Base Amount", "Access Amount", "Discount Amount", "Sponsorship Code",
  "Sponsorship Amount", "Submitted At", "Paid At",
];
beforeEach(() => vi.mocked(db.getEventSlugAndName).mockResolvedValue({ slug: event.slug, name: event.name }));

describe("legacy GET registrations export", () => {
  it("keeps exact CSV order, ISO dates, JSON values, quoting and formula-prefix escaping", async () => {
    vi.mocked(db.getRegistrationsForExport).mockResolvedValue([
      exportRegistration({ firstName: "=SUM(1,2)", lastName: 'Ben "Ali"', formData: { z: ["a", "b"], a: { city: "Tunis" } } }),
      exportRegistration({ id: "reg-2", firstName: null, lastName: null, phone: null, paymentMethod: null,
        sponsorshipCode: null, paidAt: null, formData: { b: "line1\nline2", z: null } }),
      exportRegistration({ id: "reg-3", formData: ["array-ignored"] }),
    ]);
    const result = await service.exportRegistrations("evt", { format: "csv" });
    expect(result.filename).toBe("medical-congress-registrations-2026-06-04.csv");
    expect(result.contentType).toBe("text/csv");
    expect(result.data).toBe([
      [...headers, "a", "b", "z"].join(","),
      'reg-1,amina@example.test,"\'=SUM(1,2)","Ben ""Ali""","\'+21612345678",PAID,BANK_TRANSFER,12500,10000,10000,3000,500,SP-1,2500,2026-06-03T08:15:00.000Z,2026-06-04T09:30:00.000Z,"{""city"":""Tunis""}",,"[""a"",""b""]"',
      'reg-2,amina@example.test,,,,PAID,,12500,10000,10000,3000,500,,2500,2026-06-03T08:15:00.000Z,,,"line1\nline2",',
      'reg-3,amina@example.test,Amina,Ben Ali,"\'+21612345678",PAID,BANK_TRANSFER,12500,10000,10000,3000,500,SP-1,2500,2026-06-03T08:15:00.000Z,2026-06-04T09:30:00.000Z,,,',
    ].join("\n"));
    expect(db.getRegistrationsForExport).toHaveBeenCalledWith("evt", {
      paymentStatus: undefined, paymentMethod: undefined, search: undefined, startDate: undefined, endDate: undefined,
    }, exportTx);
  });

  it.each(["=", "+", "-", "@", "\t", "\r", "\n"])("quotes and prefixes CSV strings starting with %j", async (prefix) => {
    vi.mocked(db.getRegistrationsForExport).mockResolvedValue([exportRegistration({ firstName: `${prefix}value` })]);
    const result = await service.exportRegistrations("evt", { format: "csv" });
    expect(result.data).toContain(`,"'${prefix}value",`);
  });

  it("preserves XLSX column order, dynamic width heuristics, money formats and string dates", async () => {
    vi.mocked(db.getRegistrationsForExport).mockResolvedValue([
      exportRegistration({ firstName: "=Amina", lastName: "@Ben Ali", formData: {
        "Work email": "other@example.test", "Phone amount": "+216987", "Donation amount": 250,
        "Family name": "Family", "Submitted detail": "today", "=formula header": "=SUM(1,2)", z: ["one", "two"],
      } }),
      exportRegistration({ id: "reg-2", paidAt: null, formData: { a: { city: "Tunis" } } }),
      exportRegistration({ id: "reg-3", formData: null }),
    ]);
    const result = await service.exportRegistrations("evt", { format: "xlsx", paymentStatus: "PAID", search: "Amina" });
    expect(result.filename).toBe("medical-congress-registrations-2026-06-04.xlsx");
    expect(result.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const workbook = await readWorkbook(result.data as Buffer);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Registrations"]);
    const sheet = workbook.worksheets[0];
    expect(rowValues(sheet, 1)).toEqual([...headers, "'=formula header", "Donation amount", "Family name", "Phone amount", "Submitted detail", "Work email", "a", "z"]);
    expect(rowValues(sheet, 2)).toEqual([
      "reg-1", "amina@example.test", "'=Amina", "'@Ben Ali", "'+21612345678", "PAID", "BANK_TRANSFER",
      12500, 10000, 10000, 3000, 500, "SP-1", 2500, "2026-06-03T08:15:00.000Z", "2026-06-04T09:30:00.000Z",
      "'=SUM(1,2)", "250", "Family", "'+216987", "today", "other@example.test", "", '["one","two"]',
    ]);
    expect(sheet.getCell("W3").value).toBe('{"city":"Tunis"}');
    expect(sheet.getCell("P3").value).toBe("");
    expect(rowValues(sheet, 4).slice(16)).toEqual(Array(8).fill(""));
    expect(sheet.columns.map((c) => c.width)).toEqual([38, 28, 20, 20, 18, 18, 18, 14, 14, 14, 14, 14, 18, 14, 24, 24, 18, 14, 20, 18, 24, 28, 18, 18]);
    const moneyColumns = [8, 9, 10, 11, 12, 14];
    for (let column = 1; column <= sheet.columnCount; column++) {
      expect(sheet.getCell(2, column).numFmt).toBe(moneyColumns.includes(column) ? "#,##0" : undefined);
      expect(sheet.getCell(2, column).formula).toBeUndefined();
    }
    expect(sheet.getCell("O2").type).toBe(3);
    expect(sheet.autoFilter).toBe("A1:X1");
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expectHeader(sheet.getCell("A1"));
    expect(sheet.getCell("A2").alignment).toEqual({ vertical: "top", wrapText: true });
    expect(db.getRegistrationsForExport).toHaveBeenCalledWith("evt", expect.objectContaining({ paymentStatus: "PAID", search: "Amina" }), exportTx);
  });

  it("keeps unescaped dynamic CSV headers, including commas and formula prefixes", async () => {
    // Existing drift from XLSX: legacy CSV joins raw headers without its cell escaper.
    vi.mocked(db.getRegistrationsForExport).mockResolvedValue([exportRegistration({ formData: { "=header": "value", "a,b": "value" } })]);
    const result = await service.exportRegistrations("evt", { format: "csv" });
    expect(String(result.data).split("\n")[0]).toBe([...headers, "=header", "a,b"].join(","));
  });

  it.each(["csv", "xlsx"] as const)("exports just standard headers for no registrations (%s)", async (format) => {
    vi.mocked(db.getRegistrationsForExport).mockResolvedValue([]);
    const result = await service.exportRegistrations("evt", { format });
    if (format === "csv") expect(result.data).toBe(headers.join(","));
    else {
      const sheet = (await readWorkbook(result.data as Buffer)).worksheets[0];
      expect(rowValues(sheet, 1)).toEqual(headers);
      expect(sheet.rowCount).toBe(1);
    }
  });
});
