import type ExcelJS from "exceljs";

/** Shared report palette; callers keep their own fonts, merges and row commits. */
export const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" },
};
export const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true, color: { argb: "FFFFFFFF" }, size: 11,
};
export const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" }, left: { style: "thin" },
  bottom: { style: "thin" }, right: { style: "thin" },
};

/** Styles a header row's cells and writes the row out. */
export function commitHeaderRow(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = THIN_BORDER;
  });
  row.commit();
}

/** A title row merged across `lastColumn` columns (sponsorships, check-in). */
export function addMergedTitle(
  sheet: ExcelJS.Worksheet,
  value: string,
  lastColumn: string,
  font: Partial<ExcelJS.Font>,
): void {
  const row = sheet.addRow([value]);
  sheet.mergeCells(`A${row.number}:${lastColumn}${row.number}`);
  row.getCell(1).font = font;
  row.getCell(1).alignment = { horizontal: "center" };
}
