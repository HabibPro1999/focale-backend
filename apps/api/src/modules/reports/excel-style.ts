import ExcelJS from "exceljs";
import { escapeExcelFormula } from "./excel-safety";

export const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F4E79" },
};

export const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

export function headerFont(size = 11): Partial<ExcelJS.Font> {
  return { bold: true, color: { argb: "FFFFFFFF" }, size };
}

export function newWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Focale OS";
  workbook.created = new Date();
  return workbook;
}

export function styleHeaderRow(row: ExcelJS.Row, size = 11): void {
  const font = headerFont(size);
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = font;
    cell.border = THIN_BORDER;
  });
}

/** Append title, generated date and a blank row; return the next row number. */
export function addTitleBlock(
  sheet: ExcelJS.Worksheet,
  { title, lastCol, size, generatedLabel }: {
    title: string;
    lastCol: string;
    size: number;
    generatedLabel: string;
  },
): number {
  const titleRow = sheet.addRow([escapeExcelFormula(title)]);
  sheet.mergeCells(`A${titleRow.number}:${lastCol}${titleRow.number}`);
  titleRow.getCell(1).font = { bold: true, size, color: { argb: "FF1F4E79" } };
  titleRow.getCell(1).alignment = { horizontal: "center" };

  const generatedRow = sheet.addRow([
    `${generatedLabel} ${new Date().toLocaleDateString("fr-FR")}`,
  ]);
  sheet.mergeCells(`A${generatedRow.number}:${lastCol}${generatedRow.number}`);
  generatedRow.getCell(1).font = { italic: true, size: 10, color: { argb: "FF666666" } };
  generatedRow.getCell(1).alignment = { horizontal: "center" };
  return sheet.addRow([]).number + 1;
}

export async function toXlsxBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function dateStamp(): string {
  return new Date().toISOString().split("T")[0];
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString("fr-FR");
}
