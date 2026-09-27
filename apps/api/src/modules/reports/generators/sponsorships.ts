import type ExcelJS from "exceljs";
import {
  getSponsorshipsReportData,
  iterateSponsorshipsForReport,
  withExportStatementTimeout,
  type SponsorshipReportRow,
} from "@app/db";
import { formatDate, formatDateTime, formatFileDate } from "@app/shared";
import type { ExportDownload } from "../../../core/exports/stream-io";
import {
  ColumnStyles,
  RowPacer,
  XLSX_CONTENT_TYPE,
  createXlsxWriter,
} from "../../../core/exports/xlsx-stream";
import { THIN_BORDER, commitHeaderRow, addMergedTitle } from "../excel-style";

// ============================================================================
// Sponsorships report (flat sheet)
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

const SPONSORSHIP_COLUMNS = [
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
const SPONSORSHIP_WIDTHS = [16, 28, 24, 28, 18, 18, 28, 28, 18, 30, 14, 12, 14, 22, 40, 40, 16, 24];
const SPONSORSHIP_MONEY_COLUMNS = [6, 11, 17];
/** Title, generated-on, blank, then the header. */
const SPONSORSHIP_HEADER_ROW = 4;

/**
 * Sponsorships by laboratory (French collation), newest first within a lab,
 * each row carrying its laboratory's total. The order and the totals come
 * from every filtered sponsorship's sort key; the rows are then read in that
 * order, a page of ids at a time.
 */
export async function prepareSponsorshipsReport(
  eventId: string,
  filters?: { status?: string; search?: string },
): Promise<ExportDownload> {
  const { event, currency, accessItems, keys } = await withExportStatementTimeout((tx) =>
    getSponsorshipsReportData(eventId, filters, tx),
  );

  // Keys come newest first; the sort is stable, so that order holds within a lab.
  const orderedIds = [...keys]
    .sort((a, b) => {
      const byLab = a.labName.localeCompare(b.labName, "fr", { sensitivity: "base" });
      if (byLab !== 0) return byLab;
      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .map((key) => key.id);
  const labTotals = new Map<string, number>();
  for (const key of keys) {
    const lab = getLabTotalKey(key.labName);
    labTotals.set(lab, (labTotals.get(lab) ?? 0) + key.totalAmount);
  }
  const accessNameById = new Map(accessItems.map((item) => [item.id, item.name]));

  const rowValues = (sponsorship: SponsorshipReportRow): ExcelJS.CellValue[] => {
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
    const amountApplied = sponsorship.usages.reduce((sum, usage) => sum + usage.amountApplied, 0);
    const appliedDates = sponsorship.usages
      .map((usage) => formatDateTime(usage.appliedAt))
      .join(" | ");

    return [
      sponsorship.code,
      sponsorship.batch.labName,
      sponsorship.batch.contactName,
      sponsorship.batch.email,
      sponsorship.batch.phone ?? "",
      labTotals.get(getLabTotalKey(sponsorship.batch.labName)) ?? sponsorship.totalAmount,
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
    ];
  };

  return {
    filename: `${event?.slug ?? "event"}-sponsorships-${formatFileDate()}.xlsx`,
    contentType: XLSX_CONTENT_TYPE,
    write: async (out, signal) => {
      const workbook = createXlsxWriter(out, signal);
      const sheet = workbook.addWorksheet("Sponsorships", {
        views: [{ state: "frozen", ySplit: SPONSORSHIP_HEADER_ROW }],
      });
      SPONSORSHIP_WIDTHS.forEach((width, index) => {
        sheet.getColumn(index + 1).width = width;
      });

      addMergedTitle(sheet, event?.name ?? "Sponsorships", "R", {
        bold: true,
        size: 16,
        color: { argb: "FF1F4E79" },
      });
      addMergedTitle(sheet, `Report generated: ${formatDate(new Date())}`, "R", {
        italic: true,
        size: 10,
        color: { argb: "FF666666" },
      });
      sheet.addRow([]);
      commitHeaderRow(sheet.addRow(SPONSORSHIP_COLUMNS));
      sheet.autoFilter = {
        from: { row: SPONSORSHIP_HEADER_ROW, column: 1 },
        to: { row: SPONSORSHIP_HEADER_ROW, column: SPONSORSHIP_COLUMNS.length },
      };

      const cellStyles = new ColumnStyles((column) => ({
        border: THIN_BORDER,
        alignment: { vertical: "top", wrapText: true },
        ...(SPONSORSHIP_MONEY_COLUMNS.includes(column) ? { numFmt: "#,##0" } : {}),
      }));
      const pacer = new RowPacer(out, signal, sheet);
      for await (const page of iterateSponsorshipsForReport(orderedIds, { signal })) {
        for (const sponsorship of page) {
          const dataRow = sheet.addRow(rowValues(sponsorship));
          dataRow.eachCell((cell, column) => {
            cell.style = cellStyles.for(column, cell.type);
          });
          dataRow.commit();
          await pacer.row();
        }
        await pacer.pageDone();
      }

      signal.throwIfAborted();
      sheet.commit();
      await workbook.commit();
    },
  };
}
