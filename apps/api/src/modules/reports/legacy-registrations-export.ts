import type ExcelJS from "exceljs";
import type { ExportRegistrationRow } from "@app/db";
import { escapeExcelRow } from "./excel-safety";
import { newWorkbook, styleHeaderRow, THIN_BORDER } from "./excel-style";
import { asFormRecord, formValueToString } from "./export-values";

interface LegacyColumn {
  header: string;
  value: (row: ExportRegistrationRow) => string | number;
  money?: boolean;
}

const LEGACY_COLUMNS: LegacyColumn[] = [
  { header: "ID", value: (r) => r.id },
  { header: "Email", value: (r) => r.email },
  { header: "First Name", value: (r) => r.firstName ?? "" },
  { header: "Last Name", value: (r) => r.lastName ?? "" },
  { header: "Phone", value: (r) => r.phone ?? "" },
  { header: "Payment Status", value: (r) => r.paymentStatus },
  { header: "Payment Method", value: (r) => r.paymentMethod ?? "" },
  { header: "Total Amount", value: (r) => r.totalAmount, money: true },
  { header: "Paid Amount", value: (r) => r.paidAmount, money: true },
  { header: "Base Amount", value: (r) => r.baseAmount, money: true },
  { header: "Access Amount", value: (r) => r.accessAmount, money: true },
  { header: "Discount Amount", value: (r) => r.discountAmount, money: true },
  { header: "Sponsorship Code", value: (r) => r.sponsorshipCode ?? "" },
  { header: "Sponsorship Amount", value: (r) => r.sponsorshipAmount, money: true },
  { header: "Submitted At", value: (r) => r.submittedAt.toISOString() },
  { header: "Paid At", value: (r) => r.paidAt?.toISOString() ?? "" },
];

function formDataKeys(registrations: ExportRegistrationRow[]): string[] {
  const keys = new Set<string>();
  for (const registration of registrations) {
    for (const key of Object.keys(asFormRecord(registration.formData))) keys.add(key);
  }
  return [...keys].sort();
}

function rowValues(row: ExportRegistrationRow, keys: string[]): (string | number)[] {
  const formData = asFormRecord(row.formData);
  return [
    ...LEGACY_COLUMNS.map((column) => column.value(row)),
    ...keys.map((key) => formValueToString(formData[key])),
  ];
}

// CSV also guards control-character prefixes and quotes cells; its behavior is
// deliberately different from the XLSX formula escaper. Headers stay unescaped.
function escapeCSV(value: string): string {
  if (value.length > 0 && ["\t", "\r", "\n", "=", "+", "-", "@"].includes(value[0])) {
    return `"'${value.replace(/"/g, '""')}"`;
  }
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function generateCSV(registrations: ExportRegistrationRow[]): string {
  const keys = formDataKeys(registrations);
  const headers = [...LEGACY_COLUMNS.map((column) => column.header), ...keys];
  return [
    headers.join(","),
    ...registrations.map((row) => rowValues(row, keys).map((value) => escapeCSV(String(value))).join(",")),
  ].join("\n");
}

export async function generateRegistrationsWorkbook(
  registrations: ExportRegistrationRow[],
): Promise<ExcelJS.Workbook> {
  const workbook = newWorkbook();
  const sheet = workbook.addWorksheet("Registrations");
  const keys = formDataKeys(registrations);
  const headers = [...LEGACY_COLUMNS.map((column) => column.header), ...keys];
  const headerRow = sheet.addRow(escapeExcelRow(headers));
  styleHeaderRow(headerRow);

  for (const registration of registrations) {
    const row = sheet.addRow(escapeExcelRow(rowValues(registration, keys)));
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: "top", wrapText: true };
    });
  }

  sheet.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number, column: headers.length },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  LEGACY_COLUMNS.forEach((column, index) => {
    if (column.money) sheet.getColumn(index + 1).numFmt = "#,##0";
  });

  // These checks intentionally apply to dynamic form keys as well. Keep their
  // order: e.g. "Phone amount" is width 18, while "Donation amount" is 14.
  headers.forEach((header, index) => {
    const lowerHeader = header.toLowerCase();
    let width = 18;
    if (lowerHeader.includes("email")) width = 28;
    else if (lowerHeader.includes("name")) width = 20;
    else if (lowerHeader.includes("phone")) width = 18;
    else if (lowerHeader.includes("amount")) width = 14;
    else if (lowerHeader.includes("submitted") || lowerHeader.includes("paid at")) width = 24;
    else if (header === "ID") width = 38;
    sheet.getColumn(index + 1).width = width;
  });
  return workbook;
}
