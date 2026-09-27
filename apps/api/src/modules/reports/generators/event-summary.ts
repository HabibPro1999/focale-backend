import type ExcelJS from "exceljs";
import { getEventSummaryData, withExportStatementTimeout } from "@app/db";
import { isFullySettled } from "@app/shared";
import { escapeExcelFormula } from "../excel-safety";
import { addTitleBlock, dateStamp, headerFont, HEADER_FILL, newWorkbook, THIN_BORDER, toXlsxBuffer } from "../excel-style";

function countPerAccess(
  registrations: ReadonlyArray<{ accessTypeIds: string[] }>,
  accessTypes: ReadonlyArray<{ id: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const access of accessTypes) counts[access.id] = 0;
  for (const registration of registrations) {
    for (const accessId of registration.accessTypeIds) {
      if (counts[accessId] !== undefined) counts[accessId]++;
    }
  }
  return counts;
}

/**
 * Build a styled Excel workbook summarising total registrations,
 * per-access-type counts, and confirmed-seat breakdowns for an event.
 */
export async function generateEventSummary(
  eventId: string,
): Promise<{ filename: string; data: Buffer }> {
  const { event, accessTypes, registrations } = await withExportStatementTimeout((tx) =>
    getEventSummaryData(eventId, tx),
  );

  // ── Compute stats ──

  const totalRegistrants = registrations.length;

  const accessCounts = countPerAccess(registrations, accessTypes);
  const statusCounts = new Map<string, number>();
  for (const registration of registrations) {
    const status = registration.paymentStatus;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const confirmed = registrations.filter((r) => isFullySettled(r.paymentStatus));
  const confirmedPerAccess = countPerAccess(confirmed, accessTypes);

  // ── Build Excel ──

  const workbook = newWorkbook();

  const sheet = workbook.addWorksheet("Event Report");

  const subHeaderFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD6E4F0" },
  };
  const subHeaderFont: Partial<ExcelJS.Font> = { bold: true, size: 11 };

  let row = addTitleBlock(sheet, {
    title: event!.name, lastCol: "C", size: 16, generatedLabel: "Report generated:",
  });

  const addSectionHeader = (title: string) => {
    sheet.mergeCells(`A${row}:C${row}`);
    const cell = sheet.getCell(`A${row}`);
    cell.value = escapeExcelFormula(title);
    cell.fill = HEADER_FILL;
    cell.font = headerFont(12);
    cell.border = THIN_BORDER;
    row++;
  };

  const addKVRow = (
    label: string,
    value: number | string,
    opts?: { bold?: boolean; indent?: boolean },
  ) => {
    const labelCell = sheet.getCell(`A${row}`);
    labelCell.value = escapeExcelFormula(opts?.indent ? `  - ${label}` : label);
    if (opts?.bold) labelCell.font = { bold: true, size: 11 };
    labelCell.border = THIN_BORDER;
    const valCell = sheet.getCell(`B${row}`);
    valCell.value = escapeExcelFormula(value);
    if (opts?.bold) valCell.font = { bold: true, size: 14 };
    valCell.border = THIN_BORDER;
    row++;
  };

  const addTableHeader = (cols: string[]) => {
    cols.forEach((col, i) => {
      const cell = sheet.getRow(row).getCell(i + 1);
      cell.value = escapeExcelFormula(col);
      cell.fill = subHeaderFill;
      cell.font = subHeaderFont;
      cell.border = THIN_BORDER;
    });
    row++;
  };

  const addAccessRow = (name: string, type: string, count: number) => {
    sheet.getCell(`A${row}`).value = escapeExcelFormula(name);
    sheet.getCell(`A${row}`).border = THIN_BORDER;
    sheet.getCell(`B${row}`).value = escapeExcelFormula(type);
    sheet.getCell(`B${row}`).border = THIN_BORDER;
    sheet.getCell(`C${row}`).value = count;
    sheet.getCell(`C${row}`).border = THIN_BORDER;
    sheet.getCell(`C${row}`).alignment = { horizontal: "center" };
    row++;
  };

  addSectionHeader("1. Total Registrants");
  addKVRow("Total Registrations", totalRegistrants, { bold: true });
  row++;

  addSectionHeader("2. Registrations per Access Type");
  addTableHeader(["Access Type", "Category", "Count"]);
  for (const at of accessTypes) {
    addAccessRow(at.name, at.type, accessCounts[at.id]);
  }
  row++;

  addSectionHeader("3. Payment Status Breakdown");
  addKVRow("Total Confirmed (Paid + Sponsored + Waived)", confirmed.length, {
    bold: true,
  });
  addKVRow("Paid", (statusCounts.get("PAID") ?? 0), { indent: true });
  addKVRow("Sponsored", (statusCounts.get("SPONSORED") ?? 0), { indent: true });
  addKVRow("Waived (speakers / VIPs)", (statusCounts.get("WAIVED") ?? 0), { indent: true });
  row++;
  addKVRow("Verifying", (statusCounts.get("VERIFYING") ?? 0));
  addKVRow("Partial", (statusCounts.get("PARTIAL") ?? 0));
  addKVRow("Pending", (statusCounts.get("PENDING") ?? 0));
  addKVRow("Refunded", (statusCounts.get("REFUNDED") ?? 0));
  row++;

  addSectionHeader(
    "4. Confirmed Seats per Access Type (Paid, Waived, or Sponsored)",
  );
  addTableHeader(["Access Type", "Category", "Confirmed"]);
  for (const at of accessTypes) {
    addAccessRow(at.name, at.type, confirmedPerAccess[at.id]);
  }

  sheet.getColumn(1).width = 50;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;

  const buffer = await toXlsxBuffer(workbook);
  const timestamp = dateStamp();

  return {
    filename: `${event!.slug}-summary-${timestamp}.xlsx`,
    data: buffer,
  };
}
