import type ExcelJS from "exceljs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import {
  getEventSummaryData,
  getReportEventAndAccess,
  getSponsorshipsReportData,
  iterateAccessRegistrantsForReport,
  iterateCheckInReportRows,
  iterateSponsorshipsForReport,
  withExportStatementTimeout,
  type CheckInReportRow,
  type EventSummaryData,
  type SponsorshipReportRow,
} from "@app/db";
import {
  FULLY_SETTLED_STATUSES,
  formatDate,
  formatDateTime,
  formatFileDate,
  formatTime,
  uniqueFileName,
  uniqueSheetName,
} from "@app/shared";
import type { ExportDownload } from "../../core/exports/stream-io";
import {
  ColumnStyles,
  RowPacer,
  XLSX_CONTENT_TYPE,
  createXlsxWriter,
} from "../../core/exports/xlsx-stream";
import {
  withExportTempDir,
  writeExportFile,
  writeStoredZip,
  type ZipFileEntry,
} from "../../core/exports/zip-stream";

// =============================================================================
// Report workbooks (summary, access registrants, sponsorships, check-in ZIP).
// Each `prepare*` reads the report's small header data (event, access items,
// counts or sort keys) and returns an ExportDownload whose `write` streams the
// workbook: ExcelJS's streaming writer, rows read page by page and committed
// one at a time, paced by the zip and the client. The check-in ZIP writes each
// workbook to a temp file, then streams a stored ZIP of them.
// =============================================================================

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F4E79" },
};
const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FFFFFFFF" },
  size: 11,
};
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

/** Styles a header row's cells and writes the row out. */
function commitHeaderRow(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = THIN_BORDER;
  });
  row.commit();
}

/** A title row merged across `lastColumn` columns (sponsorships, check-in). */
function addMergedTitle(
  sheet: ExcelJS.Worksheet,
  value: string,
  lastColumn: string,
  font: Partial<ExcelJS.Font>,
): void {
  const row = sheet.addRow([value]);
  sheet.mergeCells(`A${row.number}:${lastColumn}${row.number}`);
  row.getCell(1).font = font;
  row.getCell(1).alignment = { horizontal: "center" };
}

// ============================================================================
// Event summary (counts only, aggregated in SQL)
// ============================================================================

/**
 * A styled workbook summarising total registrations, per-access-type counts
 * and confirmed-seat breakdowns for an event.
 */
export async function prepareEventSummary(eventId: string): Promise<ExportDownload> {
  const data = await withExportStatementTimeout((tx) => getEventSummaryData(eventId, tx));
  return {
    filename: `${data.event!.slug}-summary-${formatFileDate()}.xlsx`,
    contentType: XLSX_CONTENT_TYPE,
    write: (out, signal) => writeEventSummary(out, signal, data),
  };
}

async function writeEventSummary(
  out: Writable,
  signal: AbortSignal,
  data: EventSummaryData,
): Promise<void> {
  const { event, accessTypes, byStatus, byAccess, total } = data;
  const statusCount = new Map(byStatus.map((s) => [s.paymentStatus, s.count]));
  const countOf = (status: string) => statusCount.get(status) ?? 0;
  const accessCount = new Map(byAccess.map((a) => [a.accessId, a]));
  const confirmed = FULLY_SETTLED_STATUSES.reduce((sum, status) => sum + countOf(status), 0);

  const workbook = createXlsxWriter(out, signal);
  const sheet = workbook.addWorksheet("Event Report");
  sheet.getColumn(1).width = 50;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;

  const headerFont: Partial<ExcelJS.Font> = { ...HEADER_FONT, size: 12 };
  const subHeaderFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD6E4F0" },
  };
  const subHeaderFont: Partial<ExcelJS.Font> = { bold: true, size: 11 };

  let row = 1;

  sheet.mergeCells(`A${row}:C${row}`);
  const titleCell = sheet.getCell(`A${row}`);
  titleCell.value = event!.name;
  titleCell.font = { bold: true, size: 16, color: { argb: "FF1F4E79" } };
  titleCell.alignment = { horizontal: "center" };
  row++;

  sheet.mergeCells(`A${row}:C${row}`);
  const dateCell = sheet.getCell(`A${row}`);
  dateCell.value = `Report generated: ${formatDate(new Date())}`;
  dateCell.font = { italic: true, size: 10, color: { argb: "FF666666" } };
  dateCell.alignment = { horizontal: "center" };
  row += 2;

  const addSectionHeader = (title: string) => {
    sheet.mergeCells(`A${row}:C${row}`);
    const cell = sheet.getCell(`A${row}`);
    cell.value = title;
    cell.fill = HEADER_FILL;
    cell.font = headerFont;
    cell.border = THIN_BORDER;
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
    labelCell.border = THIN_BORDER;
    const valCell = sheet.getCell(`B${row}`);
    valCell.value = value;
    if (opts?.bold) valCell.font = { bold: true, size: 14 };
    valCell.border = THIN_BORDER;
    row++;
  };

  const addTableHeader = (cols: string[]) => {
    cols.forEach((col, i) => {
      const cell = sheet.getRow(row).getCell(i + 1);
      cell.value = col;
      cell.fill = subHeaderFill;
      cell.font = subHeaderFont;
      cell.border = THIN_BORDER;
    });
    row++;
  };

  const addAccessRow = (name: string, type: string, count: number) => {
    sheet.getCell(`A${row}`).value = name;
    sheet.getCell(`A${row}`).border = THIN_BORDER;
    sheet.getCell(`B${row}`).value = type;
    sheet.getCell(`B${row}`).border = THIN_BORDER;
    sheet.getCell(`C${row}`).value = count;
    sheet.getCell(`C${row}`).border = THIN_BORDER;
    sheet.getCell(`C${row}`).alignment = { horizontal: "center" };
    row++;
  };

  addSectionHeader("1. Total Registrants");
  addKVRow("Total Registrations", total, { bold: true });
  row++;

  addSectionHeader("2. Registrations per Access Type");
  addTableHeader(["Access Type", "Category", "Count"]);
  for (const at of accessTypes) {
    addAccessRow(at.name, at.type, accessCount.get(at.id)?.registered ?? 0);
  }
  row++;

  addSectionHeader("3. Payment Status Breakdown");
  addKVRow("Total Confirmed (Paid + Sponsored + Waived)", confirmed, { bold: true });
  addKVRow("Paid", countOf("PAID"), { indent: true });
  addKVRow("Sponsored", countOf("SPONSORED"), { indent: true });
  addKVRow("Waived (speakers / VIPs)", countOf("WAIVED"), { indent: true });
  row++;
  addKVRow("Verifying", countOf("VERIFYING"));
  addKVRow("Partial", countOf("PARTIAL"));
  addKVRow("Pending", countOf("PENDING"));
  addKVRow("Refunded", countOf("REFUNDED"));
  row++;

  addSectionHeader("4. Confirmed Seats per Access Type (Paid, Waived, or Sponsored)");
  addTableHeader(["Access Type", "Category", "Confirmed"]);
  for (const at of accessTypes) {
    addAccessRow(at.name, at.type, accessCount.get(at.id)?.confirmed ?? 0);
  }

  signal.throwIfAborted();
  sheet.commit();
  await workbook.commit();
}

// ============================================================================
// Access registrants report (one sheet per access item)
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

// ============================================================================
// Check-in report (ZIP with one workbook per scope)
// ============================================================================

const CHECKIN_COLUMNS = [
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
const CHECKIN_WIDTHS = [14, 20, 20, 34, 18, 20, 12, 16, 12];
/** Title, generated-on, blank, then the header. */
const CHECKIN_HEADER_ROW = 4;
const CHECKED_IN_COLUMN = 7;

/**
 * One check-in workbook: checked-in registrations first, then the others,
 * each in submission order (`rows` yields them in that order).
 */
async function writeCheckInWorkbook(
  out: Writable,
  signal: AbortSignal,
  title: string,
  rows: AsyncIterable<CheckInReportRow[]>,
): Promise<void> {
  const workbook = createXlsxWriter(out, signal);
  const sheet = workbook.addWorksheet("Check-in", {
    views: [{ state: "frozen", ySplit: CHECKIN_HEADER_ROW }],
  });
  CHECKIN_WIDTHS.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  addMergedTitle(sheet, title, "I", { bold: true, size: 14, color: { argb: "FF1F4E79" } });
  addMergedTitle(sheet, `Generated: ${formatDate(new Date())}`, "I", {
    italic: true,
    size: 10,
    color: { argb: "FF666666" },
  });
  sheet.addRow([]);
  commitHeaderRow(sheet.addRow(CHECKIN_COLUMNS));
  sheet.autoFilter = {
    from: { row: CHECKIN_HEADER_ROW, column: 1 },
    to: { row: CHECKIN_HEADER_ROW, column: CHECKIN_COLUMNS.length },
  };

  const cellStyles = new ColumnStyles(() => ({ border: THIN_BORDER }));
  const checkedStyle = new ColumnStyles(() => ({
    border: THIN_BORDER,
    font: { bold: true, color: { argb: "FF22C55E" } },
  }));
  const uncheckedStyle = new ColumnStyles(() => ({
    border: THIN_BORDER,
    font: { bold: true, color: { argb: "FFEF4444" } },
  }));
  const pacer = new RowPacer(out, signal, sheet);
  for await (const page of rows) {
    for (const r of page) {
      const checkedIn = r.checkedInAt !== null;
      const dataRow = sheet.addRow([
        r.referenceNumber ?? "",
        r.lastName ?? "",
        r.firstName ?? "",
        r.email,
        r.phone ?? "",
        PAYMENT_STATUS_FR[r.paymentStatus] ?? r.paymentStatus,
        checkedIn ? "✓" : "✗",
        r.checkedInAt ? formatDate(r.checkedInAt) : "",
        r.checkedInAt ? formatTime(r.checkedInAt) : "",
      ]);
      dataRow.eachCell((cell, column) => {
        const styles =
          column !== CHECKED_IN_COLUMN ? cellStyles : checkedIn ? checkedStyle : uncheckedStyle;
        cell.style = styles.for(column, cell.type);
      });
      dataRow.commit();
      await pacer.row();
    }
    await pacer.pageDone();
  }

  signal.throwIfAborted();
  sheet.commit();
  await workbook.commit();
}

/** A check-in sheet's rows: the checked-in half, then the rest. */
async function* checkInSheetRows(
  eventId: string,
  accessId: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<CheckInReportRow[]> {
  yield* iterateCheckInReportRows(eventId, { accessId, checkedIn: true }, { signal });
  yield* iterateCheckInReportRows(eventId, { accessId, checkedIn: false }, { signal });
}

/**
 * A ZIP of the global check-in workbook plus one per access item. Each
 * workbook is streamed to a file in a private temp directory, then the ZIP is
 * streamed from those files; the directory is removed however the export ends.
 */
export async function prepareCheckInReport(eventId: string): Promise<ExportDownload> {
  const { event, accessItems } = await withExportStatementTimeout((tx) =>
    getReportEventAndAccess(eventId, tx),
  );
  const eventSlug = event?.slug ?? "event";
  const eventName = event?.name ?? "Event";

  return {
    filename: `${eventSlug}-checkin-${formatFileDate()}.zip`,
    contentType: "application/zip",
    write: (out, signal) =>
      withExportTempDir(signal, async (dir) => {
        const entries: ZipFileEntry[] = [];
        const addWorkbook = async (name: string, title: string, accessId?: string) => {
          const path = join(dir, `${entries.length}.xlsx`);
          await writeExportFile(path, signal, (file, fileSignal) =>
            writeCheckInWorkbook(
              file,
              fileSignal,
              title,
              checkInSheetRows(eventId, accessId, fileSignal),
            ),
          );
          entries.push({ name, path });
        };

        const globalEntry = `${eventSlug}-global-checkin.xlsx`;
        await addWorkbook(globalEntry, `${eventName} — Global Check-in`);
        // Entry names are unique: two access names with the same slug, or
        // names with no ASCII letters (e.g. Arabic), never overwrite each other.
        const entryNames = new Set([globalEntry.toLowerCase()]);
        for (const access of accessItems) {
          signal.throwIfAborted();
          await addWorkbook(
            uniqueFileName(access.name, "-checkin.xlsx", entryNames, "access"),
            `${access.name} — Check-in`,
            access.id,
          );
        }

        await writeStoredZip(out, entries, signal);
      }),
  };
}
