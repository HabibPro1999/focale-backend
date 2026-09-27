import type ExcelJS from "exceljs";
import {
  getRegistrationsForModularExport,
  getRegistrationTableColumns,
  getEventAccessNames,
  getEventSlugAndName,
  getSponsorshipLabDetails,
  withExportStatementTimeout,
} from "@app/db";
import type {
  ExportRegistrationsBody,
  ExportLanguage,
} from "@app/contracts";

import { dateStamp, headerFont, HEADER_FILL, newWorkbook, THIN_BORDER, toXlsxBuffer } from "./excel-style";
import { GROUP_LABELS, SHEET_NAME } from "./registrations-export/labels";
import { buildColumns, needsSponsorshipLabDetails, type ColumnDescriptor, type RowContext } from "./registrations-export/columns";

// ============================================================================
// NOTE: unlike generateRegistrationsWorkbook / excel-generator.ts, this builder
// does NOT run cell values through escapeExcelFormula / escapeExcelRow. That is
// a pre-existing CSV/XLSX formula-injection gap for user-controlled strings
// (firstName, note, form free-text) exported via this endpoint. The gap is kept
// verbatim to preserve legacy output byte-for-byte; do NOT add escaping here
// without a coordinated parity decision across clients that diff these files.
// ============================================================================

// ============================================================================
// Styling constants
// ============================================================================

const GROUP_HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 11,
  color: { argb: "FF1F4E79" },
};
const COLUMN_HEADER_FONT = headerFont();
const GROUP_FILLS: ExcelJS.Fill[] = [
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFD6E4F0" } }, // soft blue
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFEADAF0" } }, // soft violet
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EDD4" } }, // soft green
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE5B6" } }, // soft amber
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAD4D4" } }, // soft rose
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDE7EC" } }, // soft slate
];

// ============================================================================
// Workbook assembly
// ============================================================================

interface GroupSpan {
  group: keyof typeof GROUP_LABELS;
  startCol: number;
  endCol: number;
  fillIndex: number;
}

function computeGroupSpans(columns: ColumnDescriptor[]): GroupSpan[] {
  const spans: GroupSpan[] = [];
  const fillByGroup = new Map<string, number>();
  let nextFillIdx = 0;

  let current: GroupSpan | null = null;
  columns.forEach((col, i) => {
    const excelCol = i + 1;
    if (!current || current.group !== col.group) {
      if (current) spans.push(current);
      let fillIdx = fillByGroup.get(col.group);
      if (fillIdx === undefined) {
        fillIdx = nextFillIdx++ % GROUP_FILLS.length;
        fillByGroup.set(col.group, fillIdx);
      }
      current = {
        group: col.group,
        startCol: excelCol,
        endCol: excelCol,
        fillIndex: fillIdx,
      };
    } else {
      current.endCol = excelCol;
    }
  });
  if (current) spans.push(current);
  return spans;
}

function writeHeaderRows(
  sheet: ExcelJS.Worksheet,
  columns: ColumnDescriptor[],
  lang: ExportLanguage,
): void {
  // Row 1 — group headers (merged per span)
  const groupSpans = computeGroupSpans(columns);
  const groupRow = sheet.getRow(1);
  groupRow.height = 22;
  for (const span of groupSpans) {
    const range = `${sheet.getColumn(span.startCol).letter}1:${sheet.getColumn(span.endCol).letter}1`;
    if (span.startCol !== span.endCol) sheet.mergeCells(range);
    const cell = sheet.getCell(`${sheet.getColumn(span.startCol).letter}1`);
    cell.value = GROUP_LABELS[span.group][lang];
    cell.fill = GROUP_FILLS[span.fillIndex];
    cell.font = GROUP_HEADER_FONT;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = THIN_BORDER;
  }

  // Row 2 — column headers
  const headerRow = sheet.getRow(2);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.fill = HEADER_FILL;
    cell.font = COLUMN_HEADER_FONT;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = THIN_BORDER;
  });
  headerRow.height = 24;
}

function applyColumnFormatting(
  sheet: ExcelJS.Worksheet,
  columns: ColumnDescriptor[],
): void {
  columns.forEach((col, i) => {
    const excelCol = sheet.getColumn(i + 1);
    excelCol.width = col.width;
    if (col.kind === "money") excelCol.numFmt = "#,##0";
  });
}

// ============================================================================
// Public entry
// ============================================================================

export async function buildRegistrationsWorkbook(
  eventId: string,
  body: ExportRegistrationsBody,
): Promise<{ filename: string; data: Buffer }> {
  const lang = body.language;
  const { columns: cols } = body;

  // Lab details only when sponsorship-deep columns are requested.
  const needsLabDetails = needsSponsorshipLabDetails(body.columns.sponsorship);

  // Event metadata, form columns, access items, registrations (+ lab details),
  // fetched in one transaction under the export statement timeout.
  const { event, tableColumns, accessItems, registrations, labDetails } =
    await withExportStatementTimeout(async (tx) => {
      const eventRow = await getEventSlugAndName(eventId, tx);
      const columns = await getRegistrationTableColumns(eventId, tx);
      const access = await getEventAccessNames(eventId, tx);
      const rows = await getRegistrationsForModularExport(
        eventId,
        {
          paymentStatus: body.filters.paymentStatus,
          paymentMethod: body.filters.paymentMethod,
          search: body.filters.search,
          startDate: body.filters.startDate,
          endDate: body.filters.endDate,
          needCheckIns: cols.checkinAccessIds.length > 0 || cols.includeGlobalCheckin,
          needTransactions: cols.includeTransactions,
        },
        tx,
      );
      const details = needsLabDetails
        ? await getSponsorshipLabDetails(
            eventId,
            rows.map((r) => r.sponsorshipCode).filter((c): c is string => Boolean(c)),
            tx,
          )
        : [];
      return {
        event: eventRow,
        tableColumns: columns,
        accessItems: access,
        registrations: rows,
        labDetails: details,
      };
    });

  const sponsorshipByCode: RowContext["sponsorshipByCode"] = new Map(
    labDetails.map((detail) => [detail.code, {
      beneficiaryAddress: detail.beneficiaryAddress,
      batch: detail.batch,
    }]),
  );
  const accessNameById = new Map(accessItems.map((a) => [a.id, a.name]));
  const columns = buildColumns(body, accessNameById, tableColumns.formColumns, lang);

  const workbook = newWorkbook();

  const sheet = workbook.addWorksheet(SHEET_NAME[lang]);

  writeHeaderRows(sheet, columns, lang);

  for (const registration of registrations) {
    const ctx: RowContext = {
      registration,
      accessNameById,
      sponsorshipByCode,
      lang,
    };
    const row = sheet.addRow(columns.map((c) => c.getValue(ctx)));
    row.eachCell((cell, colNumber) => {
      const col = columns[colNumber - 1];
      cell.border = THIN_BORDER;
      cell.alignment = {
        vertical: "top",
        wrapText: col.kind === "longtext" || col.kind === "text",
      };
    });
  }

  applyColumnFormatting(sheet, columns);

  // Freeze the two header rows; apply autoFilter on row 2 across all data cols.
  sheet.views = [{ state: "frozen", ySplit: 2 }];
  sheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: columns.length },
  };

  const slug = event?.slug ?? "event";
  const timestamp = dateStamp();
  const filename = `${slug}-registrations-${timestamp}.xlsx`;

  const data = await toXlsxBuffer(workbook);
  return { filename, data };
}
