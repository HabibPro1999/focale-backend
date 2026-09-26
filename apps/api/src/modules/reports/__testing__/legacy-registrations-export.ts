// Verbatim copy of the pre-3.7 GET registrations export generators of
// reports.service.ts (whole result set in memory). Test-only (excluded from
// the build): the parity tests compare the streamed output with these.
import ExcelJS from "exceljs";
import type { ExportRegistrationRow } from "@app/db";
import { toCsv } from "@app/shared";

/** Pre-3.7 JSON body. */
export function legacyJson(registrations: ExportRegistrationRow[]): string {
  return JSON.stringify(registrations, null, 2);
}

/** Pre-3.7 CSV body. */
export function legacyCsv(registrations: ExportRegistrationRow[]): string {
  return generateCSV(registrations);
}

/** Pre-3.7 XLSX body. */
export async function legacyXlsx(registrations: ExportRegistrationRow[]): Promise<Buffer> {
  const workbook = await generateRegistrationsWorkbook(registrations);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ============================================================================
// CSV Export (standard headers + dynamic formData keys)
// ============================================================================

function generateCSV(registrations: ExportRegistrationRow[]): string {
  const standardHeaders = [
    "ID",
    "Email",
    "First Name",
    "Last Name",
    "Phone",
    "Payment Status",
    "Payment Method",
    "Total Amount",
    "Paid Amount",
    "Base Amount",
    "Access Amount",
    "Discount Amount",
    "Sponsorship Code",
    "Sponsorship Amount",
    "Submitted At",
    "Paid At",
  ];

  const formDataKeys = extractRegistrationFormDataKeys(registrations);
  const headers = [...standardHeaders, ...formDataKeys];

  const rows = registrations.map((r) => {
    const standardValues = [
      r.id,
      r.email,
      r.firstName ?? "",
      r.lastName ?? "",
      r.phone ?? "",
      r.paymentStatus,
      r.paymentMethod ?? "",
      r.totalAmount,
      r.paidAmount,
      r.baseAmount,
      r.accessAmount,
      r.discountAmount,
      r.sponsorshipCode ?? "",
      r.sponsorshipAmount,
      r.submittedAt.toISOString(),
      r.paidAt?.toISOString() ?? "",
    ];

    const fd =
      r.formData && typeof r.formData === "object" && !Array.isArray(r.formData)
        ? (r.formData as Record<string, unknown>)
        : {};
    const formDataValues = formDataKeys.map((key) => {
      const value = fd[key];
      if (value == null) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    });

    return [...standardValues, ...formDataValues];
  });

  // Shared CSV policy: quoted cells, formula guard, CRLF, UTF-8 BOM.
  return toCsv([headers, ...rows]);
}

async function generateRegistrationsWorkbook(
  registrations: ExportRegistrationRow[],
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Focale OS";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Registrations");

  const standardHeaders = [
    "ID",
    "Email",
    "First Name",
    "Last Name",
    "Phone",
    "Payment Status",
    "Payment Method",
    "Total Amount",
    "Paid Amount",
    "Base Amount",
    "Access Amount",
    "Discount Amount",
    "Sponsorship Code",
    "Sponsorship Amount",
    "Submitted At",
    "Paid At",
  ];

  const formDataKeys = extractRegistrationFormDataKeys(registrations);
  const headers = [...standardHeaders, ...formDataKeys];

  const headerFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E79" },
  };
  const headerFont: Partial<ExcelJS.Font> = {
    bold: true,
    color: { argb: "FFFFFFFF" },
    size: 11,
  };
  const border: Partial<ExcelJS.Borders> = {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };

  const headerRow = sheet.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = border;
  });

  for (const registration of registrations) {
    const fd =
      registration.formData &&
      typeof registration.formData === "object" &&
      !Array.isArray(registration.formData)
        ? (registration.formData as Record<string, unknown>)
        : {};

    const row = sheet.addRow(
      [
        registration.id,
        registration.email,
        registration.firstName ?? "",
        registration.lastName ?? "",
        registration.phone ?? "",
        registration.paymentStatus,
        registration.paymentMethod ?? "",
        registration.totalAmount,
        registration.paidAmount,
        registration.baseAmount,
        registration.accessAmount,
        registration.discountAmount,
        registration.sponsorshipCode ?? "",
        registration.sponsorshipAmount,
        registration.submittedAt.toISOString(),
        registration.paidAt?.toISOString() ?? "",
        ...formDataKeys.map((key) => {
          const value = fd[key];
          if (value == null) return "";
          if (typeof value === "object") return JSON.stringify(value);
          return String(value);
        }),
      ],
    );

    row.eachCell((cell) => {
      cell.border = border;
      cell.alignment = { vertical: "top", wrapText: true };
    });
  }

  sheet.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number, column: headers.length },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const moneyColumns = [8, 9, 10, 11, 12, 14];
  moneyColumns.forEach((columnNumber) => {
    sheet.getColumn(columnNumber).numFmt = "#,##0";
  });

  headers.forEach((header, index) => {
    const lowerHeader = header.toLowerCase();
    let width = 18;

    if (lowerHeader.includes("email")) width = 28;
    else if (lowerHeader.includes("name")) width = 20;
    else if (lowerHeader.includes("phone")) width = 18;
    else if (lowerHeader.includes("amount")) width = 14;
    else if (lowerHeader.includes("submitted") || lowerHeader.includes("paid at")) {
      width = 24;
    } else if (lowerHeader.includes("status") || lowerHeader.includes("method")) {
      width = 18;
    } else if (header === "ID") {
      width = 38;
    }

    sheet.getColumn(index + 1).width = width;
  });

  return workbook;
}

function extractRegistrationFormDataKeys(
  registrations: ExportRegistrationRow[],
): string[] {
  const formDataKeysSet = new Set<string>();

  for (const registration of registrations) {
    if (
      registration.formData &&
      typeof registration.formData === "object" &&
      !Array.isArray(registration.formData)
    ) {
      for (const key of Object.keys(registration.formData as Record<string, unknown>)) {
        formDataKeysSet.add(key);
      }
    }
  }

  return Array.from(formDataKeysSet).sort();
}
