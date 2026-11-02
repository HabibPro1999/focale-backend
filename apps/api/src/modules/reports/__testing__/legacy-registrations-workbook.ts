// Verbatim copy of the pre-3.7 workbook assembly of
// registrations-export-builder.ts (in-memory ExcelJS.Workbook + writeBuffer),
// fed with data instead of fetching it. Test-only (excluded from the build):
// the parity tests compare the streamed workbook with this one.
import ExcelJS from "exceljs";
import type { ExportRegistrationsBody, ExportLanguage } from "@app/contracts";
import type {
  ModularRegistrationRow,
  RegistrationTableColumns,
  SponsorshipLabDetail,
} from "@app/db";
import { formatFileDate } from "@app/shared";
import {
  BORDER,
  COLUMN_HEADER_FILL,
  COLUMN_HEADER_FONT,
  GROUP_FILLS,
  GROUP_HEADER_FONT,
  GROUP_LABELS,
  SHEET_NAME,
  resolveExportColumns,
  type ColumnDescriptor,
  type RowContext,
} from "../registrations-export-builder";

type Lang = ExportLanguage;

export interface LegacyModularExportData {
  event: { slug: string; name: string } | null;
  tableColumns: RegistrationTableColumns;
  accessItems: { id: string; name: string }[];
  registrations: ModularRegistrationRow[];
  labDetails: SponsorshipLabDetail[];
}

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

function colLetter(col: number): string {
  let s = "";
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function writeHeaderRows(
  sheet: ExcelJS.Worksheet,
  columns: ColumnDescriptor[],
  lang: Lang,
): void {
  // Row 1 — group headers (merged per span)
  const groupSpans = computeGroupSpans(columns);
  const groupRow = sheet.getRow(1);
  groupRow.height = 22;
  for (const span of groupSpans) {
    const range = `${colLetter(span.startCol)}1:${colLetter(span.endCol)}1`;
    if (span.startCol !== span.endCol) sheet.mergeCells(range);
    const cell = sheet.getCell(`${colLetter(span.startCol)}1`);
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

export async function legacyBuildRegistrationsWorkbook(
  body: ExportRegistrationsBody,
  input: LegacyModularExportData,
): Promise<{ filename: string; data: Buffer }> {
  const lang = body.language;

  // Lab details only when sponsorship-deep columns are requested.
  const needsLabDetails = body.columns.sponsorship.some((f) =>
    ["labContactName", "labEmail", "labPhone", "beneficiaryAddress"].includes(f),
  );

  // Pre-change: one fetch of every row (and lab detail) up front.
  const { event, tableColumns, accessItems, registrations, labDetails } = input;

  const sponsorshipByCode: RowContext["sponsorshipByCode"] = new Map();
  if (needsLabDetails) {
    for (const d of labDetails) {
      sponsorshipByCode.set(d.code, {
        beneficiaryAddress: d.beneficiaryAddress,
        batch: d.batch,
      });
    }
  }

  // Column descriptors are unchanged by 3.7 (buildColumns + the email fallback).
  const columns = resolveExportColumns(body, accessItems, tableColumns.formColumns);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Focale OS";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(SHEET_NAME[lang]);

  writeHeaderRows(sheet, columns, lang);

  const accessNameById = new Map(accessItems.map((a) => [a.id, a.name]));
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
      cell.border = BORDER;
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
  const timestamp = formatFileDate();
  const filename = `${slug}-registrations-${timestamp}.xlsx`;

  const data = Buffer.from(await workbook.xlsx.writeBuffer());
  return { filename, data };
}
