import ExcelJS from "exceljs";
import { prisma } from "@/database/client.js";

/**
 * Build a styled Excel workbook summarising total registrations,
 * per-access-type counts, and confirmed-seat breakdowns for an event.
 */
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
        paymentMethod: true,
        accessTypeIds: true,
        sponsorshipAmount: true,
        totalAmount: true,
      },
    }),
  ]);

  // ── Compute stats ──

  const totalRegistrants = registrations.length;

  const accessCounts: Record<string, number> = {};
  for (const at of accessTypes) accessCounts[at.id] = 0;
  for (const r of registrations) {
    for (const atId of r.accessTypeIds) {
      if (accessCounts[atId] !== undefined) accessCounts[atId]++;
    }
  }

  // Status breakdown — paymentStatus is the single source of truth
  const byStatus = (status: string) =>
    registrations.filter((r) => r.paymentStatus === status);

  const paid = byStatus("PAID");
  const sponsored = byStatus("SPONSORED");
  const waived = byStatus("WAIVED");
  const partial = byStatus("PARTIAL");
  const verifying = byStatus("VERIFYING");
  const pending = byStatus("PENDING");
  const refunded = byStatus("REFUNDED");

  // Confirmed = fully settled (PAID + SPONSORED + WAIVED)
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
  titleCell.value = event!.name;
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

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const timestamp = new Date().toISOString().split("T")[0];

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
  const [event, accessItems] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: { name: true, slug: true },
    }),
    prisma.eventAccess.findMany({
      where: { eventId },
      select: { id: true, name: true, type: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  const registrations = await prisma.registration.findMany({
    where: { eventId },
    select: {
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      paymentStatus: true,
      totalAmount: true,
      currency: true,
      submittedAt: true,
      accessTypeIds: true,
    },
    orderBy: { submittedAt: "desc" },
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Focale OS";
  workbook.created = new Date();

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

  const columns = [
    "Nom",
    "Prénom",
    "Email",
    "Téléphone",
    "Statut de paiement",
    "Montant",
    "Date d'inscription",
  ];

  for (const access of accessItems) {
    // Excel sheet names max 31 chars, no special chars
    const sheetName = access.name
      .replace(/[\\/*?[\]:]/g, "")
      .slice(0, 31);

    const sheet = workbook.addWorksheet(sheetName);

    // Header row
    const headerRow = sheet.addRow(columns);
    headerRow.eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.border = border;
    });

    // Data rows
    const accessRegs = registrations.filter((r) =>
      r.accessTypeIds.includes(access.id),
    );

    for (const reg of accessRegs) {
      const row = sheet.addRow([
        reg.lastName ?? "",
        reg.firstName ?? "",
        reg.email,
        reg.phone ?? "",
        PAYMENT_STATUS_FR[reg.paymentStatus] ?? reg.paymentStatus,
        reg.totalAmount,
        reg.submittedAt.toLocaleDateString("fr-FR"),
      ]);
      row.eachCell((cell) => {
        cell.border = border;
      });
    }

    // Column widths
    sheet.getColumn(1).width = 20;
    sheet.getColumn(2).width = 20;
    sheet.getColumn(3).width = 35;
    sheet.getColumn(4).width = 18;
    sheet.getColumn(5).width = 20;
    sheet.getColumn(6).width = 12;
    sheet.getColumn(7).width = 18;
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const timestamp = new Date().toISOString().split("T")[0];

  return {
    filename: `${event!.slug}-acces-inscrits-${timestamp}.xlsx`,
    data: buffer,
  };
}
