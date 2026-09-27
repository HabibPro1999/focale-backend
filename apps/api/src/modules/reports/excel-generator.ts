import type ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  getEventSummaryData,
  getAccessRegistrantsReportData,
  getSponsorshipsReportData,
  getCheckInReportData,
  withExportStatementTimeout,
} from "@app/db";
import { escapeExcelFormula, escapeExcelRow } from "./excel-safety";
import {
  addTitleBlock, dateStamp, formatDateTime, headerFont, HEADER_FILL,
  newWorkbook, styleHeaderRow, THIN_BORDER, toXlsxBuffer,
} from "./excel-style";

// Compatibility for the abstracts exporter until its own cleanup adopts the helper.
export { formatDateTime } from "./excel-style";

/**
 * Build a styled Excel workbook summarising total registrations,
 * per-access-type counts, and confirmed-seat breakdowns for an event.
 */
export async function generateEventSummary(
  eventId: string,
): Promise<{ filename: string; data: Buffer }> {
  const { event, accessTypes, registrations } = await withExportStatementTimeout((tx) =>
    getEventSummaryData(eventId, tx),
  );

  // ── Compute stats ──

  const totalRegistrants = registrations.length;

  const accessCounts: Record<string, number> = {};
  for (const at of accessTypes) accessCounts[at.id] = 0;
  for (const r of registrations) {
    for (const atId of r.accessTypeIds) {
      if (accessCounts[atId] !== undefined) accessCounts[atId]++;
    }
  }

  const byStatus = (status: string) =>
    registrations.filter((r) => r.paymentStatus === status);

  const paid = byStatus("PAID");
  const sponsored = byStatus("SPONSORED");
  const waived = byStatus("WAIVED");
  const partial = byStatus("PARTIAL");
  const verifying = byStatus("VERIFYING");
  const pending = byStatus("PENDING");
  const refunded = byStatus("REFUNDED");

  const confirmed = registrations.filter(
    (r) =>
      r.paymentStatus === "PAID" ||
      r.paymentStatus === "SPONSORED" ||
      r.paymentStatus === "WAIVED",
  );

  const confirmedPerAccess: Record<string, number> = {};
  for (const at of accessTypes) confirmedPerAccess[at.id] = 0;
  for (const r of confirmed) {
    for (const atId of r.accessTypeIds) {
      if (confirmedPerAccess[atId] !== undefined) confirmedPerAccess[atId]++;
    }
  }

  // ── Build Excel ──

  const workbook = newWorkbook();

  const sheet = workbook.addWorksheet("Event Report");

  const subHeaderFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD6E4F0" },
  };
  const subHeaderFont: Partial<ExcelJS.Font> = { bold: true, size: 11 };

  let row = addTitleBlock(sheet, {
    title: event!.name, lastCol: "C", size: 16, generatedLabel: "Report generated:",
  });

  const addSectionHeader = (title: string) => {
    sheet.mergeCells(`A${row}:C${row}`);
    const cell = sheet.getCell(`A${row}`);
    cell.value = escapeExcelFormula(title);
    cell.fill = HEADER_FILL;
    cell.font = headerFont(12);
    cell.border = THIN_BORDER;
    row++;
  };

  const addKVRow = (
    label: string,
    value: number | string,
    opts?: { bold?: boolean; indent?: boolean },
  ) => {
    const labelCell = sheet.getCell(`A${row}`);
    labelCell.value = escapeExcelFormula(opts?.indent ? `  - ${label}` : label);
    if (opts?.bold) labelCell.font = { bold: true, size: 11 };
    labelCell.border = THIN_BORDER;
    const valCell = sheet.getCell(`B${row}`);
    valCell.value = escapeExcelFormula(value);
    if (opts?.bold) valCell.font = { bold: true, size: 14 };
    valCell.border = THIN_BORDER;
    row++;
  };

  const addTableHeader = (cols: string[]) => {
    cols.forEach((col, i) => {
      const cell = sheet.getRow(row).getCell(i + 1);
      cell.value = escapeExcelFormula(col);
      cell.fill = subHeaderFill;
      cell.font = subHeaderFont;
      cell.border = THIN_BORDER;
    });
    row++;
  };

  const addAccessRow = (name: string, type: string, count: number) => {
    sheet.getCell(`A${row}`).value = escapeExcelFormula(name);
    sheet.getCell(`A${row}`).border = THIN_BORDER;
    sheet.getCell(`B${row}`).value = escapeExcelFormula(type);
    sheet.getCell(`B${row}`).border = THIN_BORDER;
    sheet.getCell(`C${row}`).value = count;
    sheet.getCell(`C${row}`).border = THIN_BORDER;
    sheet.getCell(`C${row}`).alignment = { horizontal: "center" };
    row++;
  };

  addSectionHeader("1. Total Registrants");
  addKVRow("Total Registrations", totalRegistrants, { bold: true });
  row++;

  addSectionHeader("2. Registrations per Access Type");
  addTableHeader(["Access Type", "Category", "Count"]);
  for (const at of accessTypes) {
    addAccessRow(at.name, at.type, accessCounts[at.id]);
  }
  row++;

  addSectionHeader("3. Payment Status Breakdown");
  addKVRow("Total Confirmed (Paid + Sponsored + Waived)", confirmed.length, {
    bold: true,
  });
  addKVRow("Paid", paid.length, { indent: true });
  addKVRow("Sponsored", sponsored.length, { indent: true });
  addKVRow("Waived (speakers / VIPs)", waived.length, { indent: true });
  row++;
  addKVRow("Verifying", verifying.length);
  addKVRow("Partial", partial.length);
  addKVRow("Pending", pending.length);
  addKVRow("Refunded", refunded.length);
  row++;

  addSectionHeader(
    "4. Confirmed Seats per Access Type (Paid, Waived, or Sponsored)",
  );
  addTableHeader(["Access Type", "Category", "Confirmed"]);
  for (const at of accessTypes) {
    addAccessRow(at.name, at.type, confirmedPerAccess[at.id]);
  }

  sheet.getColumn(1).width = 50;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;

  const buffer = await toXlsxBuffer(workbook);
  const timestamp = dateStamp();

  return {
    filename: `${event!.slug}-summary-${timestamp}.xlsx`,
    data: buffer,
  };
}

// ============================================================================
// Access Registrants Report (one sheet per access item)
// ============================================================================

const PAYMENT_STATUS_FR: Record<string, string> = {
  PAID: "Payé",
  SPONSORED: "Sponsorisé",
  WAIVED: "Exonéré",
  PARTIAL: "Partiel",
  VERIFYING: "En vérification",
  PENDING: "En attente",
  REFUNDED: "Remboursé",
};

export async function generateAccessRegistrantsReport(
  eventId: string,
): Promise<{ filename: string; data: Buffer }> {
  const { event, accessItems, registrations } =
    await withExportStatementTimeout((tx) => getAccessRegistrantsReportData(eventId, tx));

  const workbook = newWorkbook();


  const columns = [
    "Nom",
    "Prénom",
    "Email",
    "Téléphone",
    "Statut de paiement",
    "Montant",
    "Date d'inscription",
  ];

  // ponytail: zero access items -> workbook with zero worksheets (invalid xlsx).
  // Kept as legacy behaviour (documented trap), not guarded.
  for (const access of accessItems) {
    // Excel sheet names max 31 chars, no special chars. Collision on truncation
    // is unhandled — kept as legacy behaviour.
    const sheetName = access.name.replace(/[\\/*?[\]:]/g, "").slice(0, 31);

    const sheet = workbook.addWorksheet(sheetName);

    const headerRow = sheet.addRow(columns);
    styleHeaderRow(headerRow);

    const accessRegs = registrations.filter((r) =>
      r.accessTypeIds.includes(access.id),
    );

    for (const reg of accessRegs) {
      const dataRow = sheet.addRow(
        escapeExcelRow([
          reg.lastName ?? "",
          reg.firstName ?? "",
          reg.email,
          reg.phone ?? "",
          PAYMENT_STATUS_FR[reg.paymentStatus] ?? reg.paymentStatus,
          reg.totalAmount,
          reg.submittedAt.toLocaleDateString("fr-FR"),
        ]),
      );
      dataRow.eachCell((cell) => {
        cell.border = THIN_BORDER;
      });
    }

    sheet.getColumn(1).width = 20;
    sheet.getColumn(2).width = 20;
    sheet.getColumn(3).width = 35;
    sheet.getColumn(4).width = 18;
    sheet.getColumn(5).width = 20;
    sheet.getColumn(6).width = 12;
    sheet.getColumn(7).width = 18;
  }

  const buffer = await toXlsxBuffer(workbook);
  const timestamp = dateStamp();

  return {
    filename: `${event!.slug}-acces-inscrits-${timestamp}.xlsx`,
    data: buffer,
  };
}

// ============================================================================
// Sponsorships Report (flat sheet)
// ============================================================================

function getLabTotalKey(labName: string): string {
  return labName.trim().toLowerCase();
}

function formatRegistrationLabel(
  registration: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null,
): string {
  if (!registration) return "Registration deleted";

  const name = [registration.firstName, registration.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return name ? `${name} <${registration.email}>` : registration.email;
}

export async function generateSponsorshipsReport(
  eventId: string,
  filters?: { status?: string; search?: string },
): Promise<{ filename: string; data: Buffer }> {
  const { event, currency, accessItems, sponsorships } =
    await withExportStatementTimeout((tx) => getSponsorshipsReportData(eventId, filters, tx));

  const accessNameById = new Map(accessItems.map((item) => [item.id, item.name]));

  const workbook = newWorkbook();

  const sheet = workbook.addWorksheet("Sponsorships");

  addTitleBlock(sheet, {
    title: event?.name ?? "Sponsorships", lastCol: "R", size: 16, generatedLabel: "Report generated:",
  });

  const columns = [
    "Code",
    "Laboratory",
    "Contact",
    "Lab Email",
    "Lab Phone",
    "Lab Total Amount",
    "Beneficiary",
    "Beneficiary Email",
    "Beneficiary Phone",
    "Beneficiary Address",
    "Amount",
    "Currency",
    "Status",
    "Created At",
    "Coverage",
    "Linked Registrations",
    "Amount Applied",
    "Applied At",
  ];

  const headerRow = sheet.addRow(columns);
  styleHeaderRow(headerRow);

  const sortedSponsorships = [...sponsorships].sort((a, b) => {
    const byLab = a.batch.labName.localeCompare(b.batch.labName, "fr", {
      sensitivity: "base",
    });
    if (byLab !== 0) return byLab;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const labTotals = sponsorships.reduce((totals, sponsorship) => {
    const key = getLabTotalKey(sponsorship.batch.labName);
    totals.set(key, (totals.get(key) ?? 0) + sponsorship.totalAmount);
    return totals;
  }, new Map<string, number>());

  for (const sponsorship of sortedSponsorships) {
    const coveredAccessNames = sponsorship.coveredAccessIds
      .map((accessId) => accessNameById.get(accessId))
      .filter((name): name is string => Boolean(name));

    const coverageParts = [
      sponsorship.coversBasePrice ? "Base registration" : null,
      ...coveredAccessNames,
    ].filter((value): value is string => Boolean(value));

    const linkedRegistrations = sponsorship.usages
      .map((usage) => formatRegistrationLabel(usage.registration))
      .join(" | ");
    const amountApplied = sponsorship.usages.reduce(
      (sum, usage) => sum + usage.amountApplied,
      0,
    );
    const appliedDates = sponsorship.usages
      .map((usage) => formatDateTime(usage.appliedAt))
      .join(" | ");

    const dataRow = sheet.addRow(
      escapeExcelRow([
        sponsorship.code,
        sponsorship.batch.labName,
        sponsorship.batch.contactName,
        sponsorship.batch.email,
        sponsorship.batch.phone ?? "",
        labTotals.get(getLabTotalKey(sponsorship.batch.labName)) ??
          sponsorship.totalAmount,
        sponsorship.beneficiaryName,
        sponsorship.beneficiaryEmail,
        sponsorship.beneficiaryPhone ?? "",
        sponsorship.beneficiaryAddress ?? "",
        sponsorship.totalAmount,
        currency,
        sponsorship.status,
        formatDateTime(sponsorship.createdAt),
        coverageParts.join("; "),
        linkedRegistrations,
        amountApplied,
        appliedDates,
      ]),
    );

    dataRow.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: "top", wrapText: true };
    });
    dataRow.getCell(6).numFmt = "#,##0";
    dataRow.getCell(11).numFmt = "#,##0";
    dataRow.getCell(17).numFmt = "#,##0";
  }

  sheet.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number, column: columns.length },
  };
  sheet.views = [{ state: "frozen", ySplit: headerRow.number }];

  const widths = [
    16, 28, 24, 28, 18, 18, 28, 28, 18, 30, 14, 12, 14, 22, 40, 40, 16, 24,
  ];
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  const buffer = await toXlsxBuffer(workbook);
  const timestamp = dateStamp();

  return {
    filename: `${event?.slug ?? "event"}-sponsorships-${timestamp}.xlsx`,
    data: buffer,
  };
}

// ============================================================================
// Check-In Report (ZIP with one Excel per scope)
// ============================================================================

function buildCheckInSheet(
  sheet: ExcelJS.Worksheet,
  title: string,
  rows: {
    referenceNumber: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string;
    phone: string | null;
    paymentStatus: string;
    checkedIn: boolean;
    checkedInAt: Date | null;
  }[],
): void {
  addTitleBlock(sheet, {
    title, lastCol: "I", size: 14, generatedLabel: "Generated:",
  });

  const columns = [
    "Ref #",
    "Last Name",
    "First Name",
    "Email",
    "Phone",
    "Payment Status",
    "Checked In",
    "Check-in Date",
    "Check-in Time",
  ];
  const headerRow = sheet.addRow(columns);
  styleHeaderRow(headerRow);

  // Sort: checked-in first, then by submission order
  const sorted = [...rows].sort((a, b) => {
    if (a.checkedIn && !b.checkedIn) return -1;
    if (!a.checkedIn && b.checkedIn) return 1;
    return 0;
  });

  for (const r of sorted) {
    let dateStr = "";
    let timeStr = "";
    if (r.checkedInAt) {
      dateStr = r.checkedInAt.toLocaleDateString("fr-FR");
      timeStr = r.checkedInAt.toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    const dataRow = sheet.addRow(
      escapeExcelRow([
        r.referenceNumber ?? "",
        r.lastName ?? "",
        r.firstName ?? "",
        r.email,
        r.phone ?? "",
        PAYMENT_STATUS_FR[r.paymentStatus] ?? r.paymentStatus,
        r.checkedIn ? "✓" : "✗",
        dateStr,
        timeStr,
      ]),
    );

    dataRow.eachCell((cell) => {
      cell.border = THIN_BORDER;
    });

    const checkedInCell = dataRow.getCell(7);
    checkedInCell.font = {
      bold: true,
      color: { argb: r.checkedIn ? "FF22C55E" : "FFEF4444" },
    };
  }

  sheet.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number, column: columns.length },
  };
  sheet.views = [{ state: "frozen", ySplit: headerRow.number }];

  const widths = [14, 20, 20, 34, 18, 20, 12, 16, 12];
  widths.forEach((w, i) => (sheet.getColumn(i + 1).width = w));
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export async function generateCheckInReport(
  eventId: string,
): Promise<{ filename: string; data: Buffer }> {
  const { event, accessItems, registrations } = await withExportStatementTimeout((tx) =>
    getCheckInReportData(eventId, tx),
  );

  const zip = new JSZip();
  const timestamp = dateStamp();
  const eventSlug = event?.slug ?? "event";
  const eventName = event?.name ?? "Event";

  // ── 1. Global check-in sheet ──────────────────────────────────────────────

  const globalWorkbook = newWorkbook();

  const globalSheet = globalWorkbook.addWorksheet("Check-in");
  buildCheckInSheet(
    globalSheet,
    `${eventName} — Global Check-in`,
    registrations.map((r) => ({
      referenceNumber: r.referenceNumber,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      paymentStatus: r.paymentStatus,
      checkedIn: r.checkedInAt !== null,
      checkedInAt: r.checkedInAt,
    })),
  );

  const globalBuffer = await toXlsxBuffer(globalWorkbook);
  zip.file(`${eventSlug}-global-checkin.xlsx`, globalBuffer);

  // ── 2. Per-access check-in sheets ─────────────────────────────────────────
  // ponytail: two access names slugifying to the same string overwrite each
  // other's zip entry (last write wins) — kept as legacy behaviour.

  for (const access of accessItems) {
    const accessRegs = registrations.filter((r) =>
      r.accessTypeIds.includes(access.id),
    );

    const wb = newWorkbook();

    const ws = wb.addWorksheet("Check-in");
    buildCheckInSheet(
      ws,
      `${access.name} — Check-in`,
      accessRegs.map((r) => {
        const aci = r.accessCheckIns.find((c) => c.accessId === access.id);
        return {
          referenceNumber: r.referenceNumber,
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email,
          phone: r.phone,
          paymentStatus: r.paymentStatus,
          checkedIn: aci !== undefined,
          checkedInAt: aci?.checkedInAt ?? null,
        };
      }),
    );

    const buf = await toXlsxBuffer(wb);
    zip.file(`${slugify(access.name)}-checkin.xlsx`, buf);
  }

  const zipBuffer = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;

  return {
    filename: `${eventSlug}-checkin-${timestamp}.zip`,
    data: zipBuffer,
  };
}
