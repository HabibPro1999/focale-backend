import type ExcelJS from "exceljs";

// CSV/Excel formula-injection guard. A leading =, +, -, or @ in a text cell is
// interpreted by spreadsheet apps as a formula; prefixing a single quote forces
// text. Ported verbatim from the legacy reports module.
const FORMULA_PREFIXES = new Set(["=", "+", "-", "@"]);

export function escapeExcelFormula(value: ExcelJS.CellValue): ExcelJS.CellValue {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  return FORMULA_PREFIXES.has(value[0]) ? `'${value}` : value;
}

export function escapeExcelRow(values: ExcelJS.CellValue[]): ExcelJS.CellValue[] {
  return values.map(escapeExcelFormula);
}
