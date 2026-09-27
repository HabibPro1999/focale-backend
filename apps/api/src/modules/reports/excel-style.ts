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
