import type ExcelJS from "exceljs";
import type { Writable } from "node:stream";
import { getEventSummaryData, withExportStatementTimeout, type EventSummaryData } from "@app/db";
import { FULLY_SETTLED_STATUSES, formatDate, formatFileDate } from "@app/shared";
import type { ExportDownload } from "../../../core/exports/stream-io";
import { XLSX_CONTENT_TYPE, createXlsxWriter } from "../../../core/exports/xlsx-stream";
import { HEADER_FILL, HEADER_FONT, THIN_BORDER } from "../excel-style";

// ============================================================================
// Event summary (counts only, aggregated in SQL)
// ============================================================================

/**
 * A styled workbook summarising total registrations, per-access-type counts
 * and confirmed-seat breakdowns for an event.
 */
export async function prepareEventSummary(eventId: string): Promise<ExportDownload> {
  const data = await withExportStatementTimeout((tx) => getEventSummaryData(eventId, tx));
  return {
    filename: `${data.event!.slug}-summary-${formatFileDate()}.xlsx`,
    contentType: XLSX_CONTENT_TYPE,
    write: (out, signal) => writeEventSummary(out, signal, data),
  };
}

async function writeEventSummary(
  out: Writable,
  signal: AbortSignal,
  data: EventSummaryData,
): Promise<void> {
  const { event, accessTypes, byStatus, byAccess, total } = data;
  const statusCount = new Map(byStatus.map((s) => [s.paymentStatus, s.count]));
  const countOf = (status: string) => statusCount.get(status) ?? 0;
  const accessCount = new Map(byAccess.map((a) => [a.accessId, a]));
  const confirmed = FULLY_SETTLED_STATUSES.reduce((sum, status) => sum + countOf(status), 0);

  const workbook = createXlsxWriter(out, signal);
  const sheet = workbook.addWorksheet("Event Report");
  sheet.getColumn(1).width = 50;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;

  const headerFont: Partial<ExcelJS.Font> = { ...HEADER_FONT, size: 12 };
  const subHeaderFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD6E4F0" },
  };
  const subHeaderFont: Partial<ExcelJS.Font> = { bold: true, size: 11 };

  let row = 1;

  sheet.mergeCells(`A${row}:C${row}`);
  const titleCell = sheet.getCell(`A${row}`);
  titleCell.value = event!.name;
  titleCell.font = { bold: true, size: 16, color: { argb: "FF1F4E79" } };
  titleCell.alignment = { horizontal: "center" };
  row++;

  sheet.mergeCells(`A${row}:C${row}`);
  const dateCell = sheet.getCell(`A${row}`);
  dateCell.value = `Report generated: ${formatDate(new Date())}`;
  dateCell.font = { italic: true, size: 10, color: { argb: "FF666666" } };
  dateCell.alignment = { horizontal: "center" };
  row += 2;

  const addSectionHeader = (title: string) => {
    sheet.mergeCells(`A${row}:C${row}`);
    const cell = sheet.getCell(`A${row}`);
    cell.value = title;
    cell.fill = HEADER_FILL;
    cell.font = headerFont;
    cell.border = THIN_BORDER;
    row++;
  };

  const addKVRow = (
    label: string,
    value: number | string,
    opts?: { bold?: boolean; indent?: boolean },
  ) => {
    const labelCell = sheet.getCell(`A${row}`);
    labelCell.value = opts?.indent ? `  - ${label}` : label;
    if (opts?.bold) labelCell.font = { bold: true, size: 11 };
    labelCell.border = THIN_BORDER;
    const valCell = sheet.getCell(`B${row}`);
    valCell.value = value;
    if (opts?.bold) valCell.font = { bold: true, size: 14 };
    valCell.border = THIN_BORDER;
    row++;
  };

  const addTableHeader = (cols: string[]) => {
    cols.forEach((col, i) => {
      const cell = sheet.getRow(row).getCell(i + 1);
      cell.value = col;
      cell.fill = subHeaderFill;
      cell.font = subHeaderFont;
      cell.border = THIN_BORDER;
    });
    row++;
  };

  const addAccessRow = (name: string, type: string, count: number) => {
    sheet.getCell(`A${row}`).value = name;
    sheet.getCell(`A${row}`).border = THIN_BORDER;
    sheet.getCell(`B${row}`).value = type;
    sheet.getCell(`B${row}`).border = THIN_BORDER;
    sheet.getCell(`C${row}`).value = count;
    sheet.getCell(`C${row}`).border = THIN_BORDER;
    sheet.getCell(`C${row}`).alignment = { horizontal: "center" };
    row++;
  };

  addSectionHeader("1. Total Registrants");
  addKVRow("Total Registrations", total, { bold: true });
  row++;

  addSectionHeader("2. Registrations per Access Type");
  addTableHeader(["Access Type", "Category", "Count"]);
  for (const at of accessTypes) {
    addAccessRow(at.name, at.type, accessCount.get(at.id)?.registered ?? 0);
  }
  row++;

  addSectionHeader("3. Payment Status Breakdown");
  addKVRow("Total Confirmed (Paid + Sponsored + Waived)", confirmed, { bold: true });
  addKVRow("Paid", countOf("PAID"), { indent: true });
  addKVRow("Sponsored", countOf("SPONSORED"), { indent: true });
  addKVRow("Waived (speakers / VIPs)", countOf("WAIVED"), { indent: true });
  row++;
  addKVRow("Verifying", countOf("VERIFYING"));
  addKVRow("Partial", countOf("PARTIAL"));
  addKVRow("Pending", countOf("PENDING"));
  addKVRow("Refunded", countOf("REFUNDED"));
  row++;

  addSectionHeader("4. Confirmed Seats per Access Type (Paid, Waived, or Sponsored)");
  addTableHeader(["Access Type", "Category", "Confirmed"]);
  for (const at of accessTypes) {
    addAccessRow(at.name, at.type, accessCount.get(at.id)?.confirmed ?? 0);
  }

  signal.throwIfAborted();
  sheet.commit();
  await workbook.commit();
}
