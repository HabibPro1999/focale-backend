import ExcelJS from "exceljs";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll } from "vitest";
import type { ExportDownload } from "../stream-io";
import { EXPORT_TEMP_DIR_PREFIX } from "../zip-stream";

// Test helpers for export output parity (3.7): run a download into memory,
// and read a workbook back into everything a reader sees. Test-only
// (excluded from the build).

/**
 * Points os.tmpdir() at a private directory for the test file (vitest runs
 * each file in its own process), so temp-file assertions never see another
 * file's exports. Returns a lister of the export temp directories in it.
 */
export function useIsolatedTmpdir(): () => string[] {
  let dir = "";
  let previous: string | undefined;
  beforeAll(async () => {
    previous = process.env.TMPDIR;
    dir = await mkdtemp(join(tmpdir(), "focale-tmp-test-"));
    process.env.TMPDIR = dir;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return () => readdirSync(dir).filter((name) => name.startsWith(EXPORT_TEMP_DIR_PREFIX));
}

/** Runs `download.write` into memory and returns the bytes. */
export async function collect(download: ExportDownload): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => out.on("end", resolve));
  await download.write(out, new AbortController().signal);
  await ended;
  return Buffer.concat(chunks);
}

/**
 * Everything a reader sees: sheets, views, filters, merges, columns, rows,
 * cells and styles. One normalization: the in-memory writer stores "" as a
 * shared string, the streaming writer (inline strings, `t="str"`) as an empty
 * value that ExcelJS reads back as null; both show as an empty text cell, so
 * an empty string and null compare equal.
 */
export async function readBack(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as Parameters<
      typeof workbook.xlsx.load
    >[0],
  );
  return workbook.worksheets.map((sheet) => {
    const rows: unknown[] = [];
    sheet.eachRow({ includeEmpty: true }, (row, number) => {
      const cells: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const empty = cell.value === "" || cell.value === null;
        cells.push({
          address: cell.address,
          type: empty ? ExcelJS.ValueType.Null : cell.type,
          value: empty ? null : cell.value,
          numFmt: cell.numFmt,
          font: cell.font,
          fill: cell.fill,
          border: cell.border,
          alignment: cell.alignment,
        });
      });
      rows.push({ number, height: row.height, cells });
    });
    return {
      name: sheet.name,
      views: sheet.views,
      autoFilter: sheet.autoFilter,
      merges: [...(sheet.model.merges ?? [])].sort(),
      columns: (sheet.columns ?? []).map((column) => ({
        width: column.width,
        numFmt: column.numFmt,
        alignment: column.alignment,
      })),
      rowCount: sheet.rowCount,
      rows,
    };
  });
}
