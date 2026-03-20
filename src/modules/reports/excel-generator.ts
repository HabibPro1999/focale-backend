import ExcelJS from "exceljs";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

/**
 * Build a styled Excel workbook summarising total registrations,
 * per-access-type counts, and confirmed-seat breakdowns for an event.
 */
export async function generateEventSummary(
  eventId: string,
): Promise<{ filename: string; data: Buffer }> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, slug: true },
  });
  if (!event) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }

  const [accessTypes, registrations, sponsoredRows] = await Promise.all([
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
        paymentMethod: true,
        accessTypeIds: true,
        sponsorshipAmount: true,
        totalAmount: true,
      },
    }),
    prisma.sponsorshipUsage.findMany({
      where: {
        sponsorship: { eventId },
        registrationId: { not: null },
      },
      select: { registrationId: true },
      distinct: ["registrationId"],
    }),
  ]);

  const sponsoredRegIds = new Set(sponsoredRows.map((r) => r.registrationId));

  // ── Compute stats ──

  const totalRegistrants = registrations.length;

  const accessCounts: Record<string, number> = {};
  for (const at of accessTypes) accessCounts[at.id] = 0;
  for (const r of registrations) {
    for (const atId of r.accessTypeIds) {
      if (accessCounts[atId] !== undefined) accessCounts[atId]++;
    }
  }

  // WAIVED is treated as a confirmed terminal state (e.g. speakers, VIPs)
  const paidOnly = registrations.filter(
    (r) => r.paymentStatus === "PAID" && !sponsoredRegIds.has(r.id),
  );
  const sponsoredOnly = registrations.filter(
    (r) =>
      r.paymentStatus !== "PAID" &&
      r.paymentStatus !== "WAIVED" &&
      sponsoredRegIds.has(r.id),
  );
  const paidAndSponsored = registrations.filter(
    (r) => r.paymentStatus === "PAID" && sponsoredRegIds.has(r.id),
  );
  const waivedOnly = registrations.filter(
    (r) => r.paymentStatus === "WAIVED" && !sponsoredRegIds.has(r.id),
  );
  const confirmed = registrations.filter(
    (r) =>
      r.paymentStatus === "PAID" ||
      r.paymentStatus === "WAIVED" ||
      sponsoredRegIds.has(r.id),
  );

  const confirmedPerAccess: Record<string, number> = {};
  for (const at of accessTypes) confirmedPerAccess[at.id] = 0;
  for (const r of confirmed) {
    for (const atId of r.accessTypeIds) {
      if (confirmedPerAccess[atId] !== undefined) confirmedPerAccess[atId]++;
    }
  }

  // ── Build Excel ──

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
  row++;

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
    row++;
  };

  const addKVRow = (
    label: string,
    value: number | string,
    opts?: { bold?: boolean; indent?: boolean },
  ) => {
    const labelCell = sheet.getCell(`A${row}`);
    labelCell.value = opts?.indent ? `  - ${label}` : label;
    if (opts?.bold) labelCell.font = { bold: true, size: 11 };
    labelCell.border = border;
    const valCell = sheet.getCell(`B${row}`);
    valCell.value = value;
    if (opts?.bold) valCell.font = { bold: true, size: 14 };
    valCell.border = border;
    row++;
  };

  const addTableHeader = (cols: string[]) => {
    cols.forEach((col, i) => {
      const cell = sheet.getRow(row).getCell(i + 1);
      cell.value = col;
      cell.fill = subHeaderFill;
      cell.font = subHeaderFont;
      cell.border = border;
    });
    row++;
  };

  const addAccessRow = (name: string, type: string, count: number) => {
    sheet.getCell(`A${row}`).value = name;
    sheet.getCell(`A${row}`).border = border;
    sheet.getCell(`B${row}`).value = type;
    sheet.getCell(`B${row}`).border = border;
    sheet.getCell(`C${row}`).value = count;
    sheet.getCell(`C${row}`).border = border;
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

  addSectionHeader("3. Total Confirmed (Paid, Waived, or Sponsored)");
  addKVRow("Total Confirmed", confirmed.length, { bold: true });
  addKVRow("Paid only (PAID, no sponsorship)", paidOnly.length, {
    indent: true,
  });
  addKVRow("Paid + Sponsored", paidAndSponsored.length, { indent: true });
  addKVRow("Sponsored only (not yet PAID)", sponsoredOnly.length, {
    indent: true,
  });
  addKVRow("Waived (speakers / VIPs)", waivedOnly.length, { indent: true });
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

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const timestamp = new Date().toISOString().split("T")[0];

  return {
    filename: `${event.slug}-summary-${timestamp}.xlsx`,
    data: buffer,
  };
}
