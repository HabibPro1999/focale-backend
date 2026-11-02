import { join } from "node:path";
import type { Writable } from "node:stream";
import {
  getReportEventAndAccess,
  iterateCheckInReportRows,
  withExportStatementTimeout,
  type CheckInReportRow,
} from "@app/db";
import { formatDate, formatFileDate, formatTime, uniqueFileName } from "@app/shared";
import type { ExportDownload } from "../../../core/exports/stream-io";
import { ColumnStyles, RowPacer, createXlsxWriter } from "../../../core/exports/xlsx-stream";
import {
  withExportTempDir,
  writeExportFile,
  writeStoredZip,
  type ZipFileEntry,
} from "../../../core/exports/zip-stream";
import { THIN_BORDER, commitHeaderRow, addMergedTitle } from "../excel-style";
import { PAYMENT_STATUS_FR } from "../registrations-export/labels";

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
