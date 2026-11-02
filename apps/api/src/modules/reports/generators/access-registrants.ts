import {
  getReportEventAndAccess,
  iterateAccessRegistrantsForReport,
  withExportStatementTimeout,
} from "@app/db";
import { formatDate, formatFileDate, uniqueSheetName } from "@app/shared";
import type { ExportDownload } from "../../../core/exports/stream-io";
import {
  ColumnStyles,
  RowPacer,
  XLSX_CONTENT_TYPE,
  createXlsxWriter,
} from "../../../core/exports/xlsx-stream";
import { THIN_BORDER, commitHeaderRow } from "../excel-style";
import { PAYMENT_STATUS_FR } from "../registrations-export/labels";

// ============================================================================
// Access registrants report (one sheet per access item)
// ============================================================================

const ACCESS_REGISTRANT_COLUMNS = [
  "Nom",
  "Prénom",
  "Email",
  "Téléphone",
  "Statut de paiement",
  "Montant",
  "Date d'inscription",
];
const ACCESS_REGISTRANT_WIDTHS = [20, 20, 35, 18, 20, 12, 18];

export async function prepareAccessRegistrantsReport(
  eventId: string,
): Promise<ExportDownload> {
  const { event, accessItems } = await withExportStatementTimeout((tx) =>
    getReportEventAndAccess(eventId, tx),
  );
  return {
    filename: `${event!.slug}-acces-inscrits-${formatFileDate()}.xlsx`,
    contentType: XLSX_CONTENT_TYPE,
    write: async (out, signal) => {
      const workbook = createXlsxWriter(out, signal);
      const cellStyles = new ColumnStyles(() => ({ border: THIN_BORDER }));

      // One sheet per access item, each written out before the next starts;
      // names are made valid and unique (Excel rejects duplicates, e.g. two
      // names equal after truncation to 31 characters).
      const sheetNames = new Set<string>();
      for (const access of accessItems) {
        signal.throwIfAborted();
        const sheet = workbook.addWorksheet(uniqueSheetName(access.name, sheetNames, "Accès"));
        ACCESS_REGISTRANT_WIDTHS.forEach((width, index) => {
          sheet.getColumn(index + 1).width = width;
        });
        commitHeaderRow(sheet.addRow(ACCESS_REGISTRANT_COLUMNS));

        const pacer = new RowPacer(out, signal, sheet);
        for await (const page of iterateAccessRegistrantsForReport(eventId, access.id, {
          signal,
        })) {
          for (const reg of page) {
            const dataRow = sheet.addRow([
              reg.lastName ?? "",
              reg.firstName ?? "",
              reg.email,
              reg.phone ?? "",
              PAYMENT_STATUS_FR[reg.paymentStatus] ?? reg.paymentStatus,
              reg.totalAmount,
              formatDate(reg.submittedAt),
            ]);
            dataRow.eachCell((cell, column) => {
              cell.style = cellStyles.for(column, cell.type);
            });
            dataRow.commit();
            await pacer.row();
          }
          await pacer.pageDone();
        }
        sheet.commit();
      }
      if (accessItems.length === 0) {
        // A workbook needs at least one sheet to open.
        const sheet = workbook.addWorksheet("Accès");
        sheet.addRow(["Aucun accès pour cet événement."]).commit();
        sheet.commit();
      }

      signal.throwIfAborted();
      await workbook.commit();
    },
  };
}
