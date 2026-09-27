import { getAccessRegistrantsReportData, withExportStatementTimeout } from "@app/db";
import { escapeExcelRow } from "../excel-safety";
import { dateStamp, newWorkbook, styleHeaderRow, THIN_BORDER, toXlsxBuffer } from "../excel-style";
import { PAYMENT_STATUS_FR } from "../registrations-export/labels";

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
