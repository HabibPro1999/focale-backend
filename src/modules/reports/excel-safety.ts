import type ExcelJS from "exceljs";

const FORMULA_PREFIXES = new Set(["=", "+", "-", "@"]);

export function escapeExcelFormula(
  value: ExcelJS.CellValue,
): ExcelJS.CellValue {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  return FORMULA_PREFIXES.has(value[0]) ? `'${value}` : value;
}

export function escapeExcelRow(
  values: ExcelJS.CellValue[],
): ExcelJS.CellValue[] {
  return values.map(escapeExcelFormula);
}
