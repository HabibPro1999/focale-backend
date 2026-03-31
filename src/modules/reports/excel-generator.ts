// ============================================================================
// Reports Module - Excel Generator
// ============================================================================

import ExcelJS from "exceljs";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

export async function generateEventSummary(
  eventId: string,
): Promise<{ filename: string; data: Buffer }> {
  const [event, accessTypes, registrations] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: { name: true, slug: true },
    }),
    prisma.eventAccess.findMany({
      where: { eventId },
      select: { id: true, name: true, type: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.registration.findMany({
      where: { eventId },
      select: {
        id: true,
        paymentStatus: true,
        accessTypeIds: true,
        totalAmount: true,
        sponsorshipAmount: true,
      },
    }),
  ]);

  if (!event) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  const totalRegistrants = registrations.length;

  // --- Registrations per access type (all) ---
  const accessCounts: Record<string, number> = {};
  for (const accessType of accessTypes) {
    accessCounts[accessType.id] = 0;
  }
  for (const registration of registrations) {
    for (const accessTypeId of registration.accessTypeIds) {
      if (accessCounts[accessTypeId] !== undefined) {
        accessCounts[accessTypeId] += 1;
      }
    }
  }

  // --- Settled = PAID + WAIVED ---
  const settled = registrations.filter(
    (r) => r.paymentStatus === "PAID" || r.paymentStatus === "WAIVED",
  );

  // Settled breakdown
  const selfPaid = settled.filter(
    (r) =>
      r.paymentStatus === "PAID" && r.sponsorshipAmount === 0,
  );
  const settledFullySponsored = settled.filter(
    (r) =>
      r.paymentStatus === "PAID" &&
      r.sponsorshipAmount >= r.totalAmount &&
      r.sponsorshipAmount > 0,
  );
  const settledPartiallySponsored = settled.filter(
    (r) =>
      r.paymentStatus === "PAID" &&
      r.sponsorshipAmount > 0 &&
      r.sponsorshipAmount < r.totalAmount,
  );
  const waivedOnly = settled.filter(
    (r) => r.paymentStatus === "WAIVED",
  );

  // --- Sponsorship coverage (all registrations) ---
  const fullySponsored = registrations.filter(
    (r) => r.sponsorshipAmount >= r.totalAmount && r.sponsorshipAmount > 0,
  );
  const partiallySponsored = registrations.filter(
    (r) => r.sponsorshipAmount > 0 && r.sponsorshipAmount < r.totalAmount,
  );
  const notSponsored = registrations.filter(
    (r) => r.sponsorshipAmount === 0,
  );

  // --- Settled per access type ---
  const settledPerAccess: Record<string, number> = {};
  for (const accessType of accessTypes) {
    settledPerAccess[accessType.id] = 0;
  }
  for (const registration of settled) {
    for (const accessTypeId of registration.accessTypeIds) {
      if (settledPerAccess[accessTypeId] !== undefined) {
        settledPerAccess[accessTypeId] += 1;
      }
    }
  }

  // ============================================================================
  // Build workbook
  // ============================================================================

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Focale OS";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Event Report");

  const headerFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E79" },
  };
  const headerFont: Partial<ExcelJS.Font> = {
    bold: true,
    color: { argb: "FFFFFFFF" },
    size: 12,
  };
  const subHeaderFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD6E4F0" },
  };
  const subHeaderFont: Partial<ExcelJS.Font> = { bold: true, size: 11 };
  const border: Partial<ExcelJS.Borders> = {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };

  let row = 1;

  sheet.mergeCells(`A${row}:C${row}`);
  const titleCell = sheet.getCell(`A${row}`);
  titleCell.value = event.name;
  titleCell.font = { bold: true, size: 16, color: { argb: "FF1F4E79" } };
  titleCell.alignment = { horizontal: "center" };
  row += 1;

  sheet.mergeCells(`A${row}:C${row}`);
  const dateCell = sheet.getCell(`A${row}`);
  dateCell.value = `Report generated: ${new Date().toLocaleDateString("fr-FR")}`;
  dateCell.font = { italic: true, size: 10, color: { argb: "FF666666" } };
  dateCell.alignment = { horizontal: "center" };
  row += 2;

  const addSectionHeader = (title: string) => {
    sheet.mergeCells(`A${row}:C${row}`);
    const cell = sheet.getCell(`A${row}`);
    cell.value = title;
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = border;
    row += 1;
  };

  const addKeyValueRow = (
    label: string,
    value: number | string,
    options?: { bold?: boolean; indent?: boolean },
  ) => {
    const labelCell = sheet.getCell(`A${row}`);
    labelCell.value = options?.indent ? `  - ${label}` : label;
    if (options?.bold) {
      labelCell.font = { bold: true, size: 11 };
    }
    labelCell.border = border;

    const valueCell = sheet.getCell(`B${row}`);
    valueCell.value = value;
    if (options?.bold) {
      valueCell.font = { bold: true, size: 14 };
    }
    valueCell.border = border;

    row += 1;
  };

  const addTableHeader = (columns: string[]) => {
    columns.forEach((column, index) => {
      const cell = sheet.getRow(row).getCell(index + 1);
      cell.value = column;
      cell.fill = subHeaderFill;
      cell.font = subHeaderFont;
      cell.border = border;
    });
    row += 1;
  };

  const addAccessRow = (name: string, type: string, count: number) => {
    sheet.getCell(`A${row}`).value = name;
    sheet.getCell(`A${row}`).border = border;
    sheet.getCell(`B${row}`).value = type;
    sheet.getCell(`B${row}`).border = border;
    sheet.getCell(`C${row}`).value = count;
    sheet.getCell(`C${row}`).border = border;
    sheet.getCell(`C${row}`).alignment = { horizontal: "center" };
    row += 1;
  };

  // Section 1: Total Registrants
  addSectionHeader("1. Total Registrants");
  addKeyValueRow("Total Registrations", totalRegistrants, { bold: true });
  row += 1;

  // Section 2: Registrations per Access Type
  addSectionHeader("2. Registrations per Access Type");
  addTableHeader(["Access Type", "Category", "Count"]);
  for (const accessType of accessTypes) {
    addAccessRow(accessType.name, accessType.type, accessCounts[accessType.id]);
  }
  row += 1;

  // Section 3: Settled Registrations (Paid + Waived)
  addSectionHeader("3. Settled Registrations (Paid + Waived)");
  addKeyValueRow("Total Settled", settled.length, { bold: true });
  addKeyValueRow("Self-paid (no sponsorship)", selfPaid.length, {
    indent: true,
  });
  addKeyValueRow("Fully Sponsored", settledFullySponsored.length, {
    indent: true,
  });
  addKeyValueRow(
    "Partially Sponsored (remainder paid)",
    settledPartiallySponsored.length,
    { indent: true },
  );
  addKeyValueRow("Waived (speakers / VIPs)", waivedOnly.length, {
    indent: true,
  });
  row += 1;

  // Section 4: Sponsorship Coverage (All Registrations)
  addSectionHeader("4. Sponsorship Coverage (All Registrations)");
  addKeyValueRow("Fully Sponsored", fullySponsored.length, { indent: true });
  addKeyValueRow(
    "Partially Sponsored (remaining unpaid)",
    partiallySponsored.length,
    { indent: true },
  );
  addKeyValueRow("Not Sponsored", notSponsored.length, { indent: true });
  row += 1;

  // Section 5: Settled Seats per Access Type
  addSectionHeader("5. Settled Seats per Access Type (Paid + Waived)");
  addTableHeader(["Access Type", "Category", "Settled"]);
  for (const accessType of accessTypes) {
    addAccessRow(
      accessType.name,
      accessType.type,
      settledPerAccess[accessType.id],
    );
  }

  sheet.getColumn(1).width = 50;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const timestamp = new Date().toISOString().split("T")[0];

  return {
    filename: `${event.slug}-summary-${timestamp}.xlsx`,
    data: buffer,
  };
}
