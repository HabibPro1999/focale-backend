import type ExcelJS from "exceljs";
import type { Writable } from "node:stream";
import {
  iterateRegistrationsForModularExport,
  getRegistrationTableColumns,
  getEventAccessNames,
  getEventSlugAndName,
  getSponsorshipLabDetails,
  withExportStatementTimeout,
  type ModularRegistrationRow,
} from "@app/db";
import type {
  ExportRegistrationsBody,
  ExportLanguage,
} from "@app/contracts";
import { formatFileDate } from "@app/shared";
import type { ExportDownload } from "../../core/exports/stream-io";
import {
  XLSX_CONTENT_TYPE,
  ColumnStyles,
  RowPacer,
  createXlsxWriter,
} from "../../core/exports/xlsx-stream";

import { HEADER_FILL as COLUMN_HEADER_FILL, HEADER_FONT as COLUMN_HEADER_FONT, THIN_BORDER as BORDER } from "./excel-style";
import { GROUP_LABELS, SHEET_NAME } from "./registrations-export/labels";
import { resolveExportColumns, needsSponsorshipLabDetails, type ColumnDescriptor, type RowContext } from "./registrations-export/columns";
export { GROUP_LABELS, IDENTITY_HEADERS, SHEET_NAME } from "./registrations-export/labels";
export { resolveExportColumns, type ColumnDescriptor, type RowContext } from "./registrations-export/columns";

// ============================================================================
// Cell values are written as plain strings: exceljs stores them as text cells,
// which spreadsheet apps never evaluate as formulas, so XLSX needs no escaping
// (the shared export policy in @app/shared export-format; CSV is escaped).
// ============================================================================

// ============================================================================
// Styling constants
// ============================================================================

const MONEY_FORMAT = "#,##0";

export const GROUP_HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 11,
  color: { argb: "FF1F4E79" },
};
export { HEADER_FILL as COLUMN_HEADER_FILL, HEADER_FONT as COLUMN_HEADER_FONT, THIN_BORDER as BORDER } from "./excel-style";
export const GROUP_FILLS: ExcelJS.Fill[] = [
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFD6E4F0" } }, // soft blue
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFEADAF0" } }, // soft violet
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EDD4" } }, // soft green
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE5B6" } }, // soft amber
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAD4D4" } }, // soft rose
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDE7EC" } }, // soft slate
];

// ============================================================================
// Localized labels
// ============================================================================

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

/** Group row (1) and column header row (2); rows are committed by the caller. */
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
    cell.border = BORDER;
  }

  // Row 2 — column headers
  const headerRow = sheet.getRow(2);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.fill = COLUMN_HEADER_FILL;
    cell.font = COLUMN_HEADER_FONT;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = BORDER;
  });
  headerRow.height = 24;
}

/**
 * Widths and the money number format. A streamed sheet writes its column
 * definitions with the first committed row, so this runs before any commit;
 * the header cells get the format now, cells created later inherit it.
 */
function applyColumnFormatting(
  sheet: ExcelJS.Worksheet,
  columns: ColumnDescriptor[],
): void {
  columns.forEach((col, i) => {
    const excelCol = sheet.getColumn(i + 1);
    excelCol.width = col.width;
    if (col.kind === "money") excelCol.numFmt = MONEY_FORMAT;
  });
}

// ============================================================================
// Public entry
// ============================================================================

/**
 * Prepares the modular registrations workbook: event metadata, form columns
 * and access names are read now (one transaction); the rows are streamed by
 * `write`, one keyset page at a time, each page's rows committed as written.
 */
export async function prepareRegistrationsWorkbook(
  eventId: string,
  body: ExportRegistrationsBody,
): Promise<ExportDownload> {
  const { columns: cols } = body;

  const { event, tableColumns, accessItems } = await withExportStatementTimeout(
    async (tx) => ({
      event: await getEventSlugAndName(eventId, tx),
      tableColumns: await getRegistrationTableColumns(eventId, tx),
      accessItems: await getEventAccessNames(eventId, tx),
    }),
  );

  const accessNameById = new Map(accessItems.map((a) => [a.id, a.name]));
  const columns = resolveExportColumns(body, accessItems, tableColumns.formColumns, accessNameById);
  const slug = event?.slug ?? "event";
  const timestamp = formatFileDate();

  return {
    filename: `${slug}-registrations-${timestamp}.xlsx`,
    contentType: XLSX_CONTENT_TYPE,
    write: (out, signal) =>
      writeRegistrationsWorkbook(out, signal, {
        eventId,
        body,
        columns,
        accessItems,
        accessNameById,
        pages: iterateRegistrationsForModularExport(
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
          { signal },
        ),
      }),
  };
}

interface WorkbookInput {
  eventId: string;
  body: ExportRegistrationsBody;
  columns: ColumnDescriptor[];
  accessItems: { id: string; name: string }[];
  accessNameById?: Map<string, string>;
  pages: AsyncIterable<ModularRegistrationRow[]>;
}

/** Streams the workbook into `out` (ended by the workbook commit). */
export async function writeRegistrationsWorkbook(
  out: Writable,
  signal: AbortSignal,
  input: WorkbookInput,
): Promise<void> {
  const { eventId, body, columns, accessItems } = input;
  const lang = body.language;
  // Lab details only when sponsorship-deep columns are requested; looked up
  // per page for the codes not seen yet.
  const needsLabDetails = needsSponsorshipLabDetails(body.columns.sponsorship);
  const sponsorshipByCode: RowContext["sponsorshipByCode"] = new Map();
  const lookedUpCodes = new Set<string>();
  const accessNameById = input.accessNameById ?? new Map(accessItems.map((a) => [a.id, a.name]));

  const workbook = createXlsxWriter(out, signal);
  // Freeze the two header rows.
  const sheet = workbook.addWorksheet(SHEET_NAME[lang], {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  writeHeaderRows(sheet, columns, lang);
  // Before the first commit: the column definitions go out with it.
  applyColumnFormatting(sheet, columns);
  sheet.getRow(2).commit();
  // autoFilter on row 2 across all data columns (written with the sheet).
  sheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: columns.length },
  };

  const cellStyles = new ColumnStyles((column) => {
    const col = columns[column - 1]!;
    return {
      ...(col.kind === "money" ? { numFmt: MONEY_FORMAT } : {}),
      border: BORDER,
      alignment: { vertical: "top", wrapText: col.kind === "longtext" || col.kind === "text" },
    };
  });
  const pacer = new RowPacer(out, signal, sheet);
  for await (const page of input.pages) {
    if (needsLabDetails) {
      const codes = [
        ...new Set(
          page
            .map((r) => r.sponsorshipCode)
            .filter((c): c is string => Boolean(c) && !lookedUpCodes.has(c!)),
        ),
      ];
      if (codes.length > 0) {
        const details = await withExportStatementTimeout((tx) =>
          getSponsorshipLabDetails(eventId, codes, tx),
        );
        for (const code of codes) lookedUpCodes.add(code);
        for (const d of details) {
          sponsorshipByCode.set(d.code, {
            beneficiaryAddress: d.beneficiaryAddress,
            batch: d.batch,
          });
        }
      }
    }

    for (const registration of page) {
      const ctx: RowContext = {
        registration,
        accessNameById,
        sponsorshipByCode,
        lang,
      };
      const row = sheet.addRow(columns.map((c) => c.getValue(ctx)));
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
