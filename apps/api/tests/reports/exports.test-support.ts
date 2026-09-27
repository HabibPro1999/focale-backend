import ExcelJS from "exceljs";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { ExportRegistrationRow } from "@app/db";

// Shared report-test support stays outside src so production builds omit it.
// Inspect serialized XLSX cells, never ZIP bytes or binary snapshots. Only Date
// is faked: ExcelJS/JSZip still need real timers to finish their asynchronous IO.
export function useExportClock(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TZ", "UTC");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-04T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
}

export async function readWorkbook(data: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as Parameters<typeof workbook.xlsx.load>[0]);
  expect(workbook.creator).toBe("Focale OS");
  expect(workbook.created).toEqual(new Date("2026-06-04T12:00:00Z"));
  return workbook;
}

export function rowValues(sheet: ExcelJS.Worksheet, row: number, columns = sheet.columnCount) {
  return Array.from({ length: columns }, (_, i) => sheet.getCell(row, i + 1).value);
}

export function expectHeader(cell: ExcelJS.Cell, size = 11): void {
  expect(cell.fill).toEqual({ type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } });
  expect(cell.font).toMatchObject({ bold: true, color: { argb: "FFFFFFFF" }, size });
  expect(cell.border).toEqual({
    top: { style: "thin" }, bottom: { style: "thin" },
    left: { style: "thin" }, right: { style: "thin" },
  });
}

export const event = { name: "Medical Congress", slug: "medical-congress" };
export const accessItems = [
  { id: "access-workshop", name: "Workshop", type: "WORKSHOP" },
  { id: "access-dinner", name: "Dinner", type: "OTHER" },
];
export const submittedAt = new Date("2026-06-03T08:15:00Z");
export const paidAt = new Date("2026-06-04T09:30:00Z");

export function exportRegistration(overrides: Partial<ExportRegistrationRow> = {}): ExportRegistrationRow {
  return {
    id: "reg-1", email: "amina@example.test", firstName: "Amina", lastName: "Ben Ali",
    phone: "+21612345678", paymentStatus: "PAID", paymentMethod: "BANK_TRANSFER",
    totalAmount: 12500, paidAmount: 10000, baseAmount: 10000, accessAmount: 3000,
    discountAmount: 500, sponsorshipCode: "SP-1", sponsorshipAmount: 2500,
    submittedAt, paidAt, formData: {}, ...overrides,
  };
}
