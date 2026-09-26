import ExcelJS from "exceljs";
import type { Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { whenWritable } from "./stream-io";

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Longest a generator runs rows before yielding to the event loop. A styled
 * 60-column row costs about 1 ms, so a fixed row count would not bound the
 * pause; the clock does.
 */
export const YIELD_AFTER_MS = 20;

/**
 * An ExcelJS streaming workbook writing into `out`: styles on, inline strings
 * (no shared-string table growing with the file). Each committed row is
 * serialized and zipped as it goes; `workbook.commit()` ends `out`. If
 * `signal` aborts, the zip is abandoned.
 */
export function createXlsxWriter(
  out: Writable,
  signal: AbortSignal,
): ExcelJS.stream.xlsx.WorkbookWriter {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: out,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = "Focale OS";
  workbook.created = new Date();
  const zip = workbookZip(workbook);
  signal.addEventListener(
    "abort",
    () => {
      try {
        zip?.abort();
      } catch {
        // best effort: the output is already gone
      }
    },
    { once: true },
  );
  return workbook;
}

// Two ExcelJS 4.4 internals (the version is pinned): the workbook's archiver,
// abandoned on abort, and the stream a sheet's XML is zipped from, which
// paces generation. Without them exports still work, but an abort lets the
// zip run on and rows can pile up ahead of deflate; xlsx-stream.test.ts fails
// if an ExcelJS upgrade removes either.

/** The streaming workbook's archiver (ExcelJS's internal `zip`). */
export function workbookZip(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
): { abort: () => void } | undefined {
  const zip = (workbook as unknown as { zip?: { abort?: unknown } }).zip;
  return zip && typeof zip.abort === "function" ? (zip as { abort: () => void }) : undefined;
}

/**
 * Shared cell styles for one column's data cells. ExcelJS caches a style's
 * index by object identity (a WeakMap), so cells sharing one object skip the
 * per-cell style serialization that dominates a large sheet's CPU and garbage.
 * The cached index also depends on the value type (a number gets the General
 * format), hence one object per column and type. Never mutate a shared style.
 */
export class ColumnStyles {
  private readonly byColumn: Map<number, Partial<ExcelJS.Style>>[] = [];

  constructor(private readonly styleOf: (column: number) => Partial<ExcelJS.Style>) {}

  /** Style for the cell in 1-based `column` holding a value of `type`. */
  for(column: number, type: ExcelJS.ValueType): Partial<ExcelJS.Style> {
    const byType = (this.byColumn[column] ??= new Map());
    let style = byType.get(type);
    if (!style) {
      style = this.styleOf(column);
      byType.set(type, style);
    }
    return style;
  }
}

/**
 * The stream archiver reads a streamed sheet's XML from, once the zip has
 * reached that entry. ExcelJS 4.4's StreamBuf keeps its pipe targets in
 * `pipes` and writes to them without honoring backpressure, so rows produced
 * faster than deflate would pile up there, uncompressed.
 */
export function sheetZipInput(sheet: ExcelJS.Worksheet): Writable | undefined {
  const stream = (sheet as unknown as { stream?: { pipes?: unknown[] } }).stream;
  const target = stream?.pipes?.[0];
  return target && typeof (target as Writable).write === "function"
    ? (target as Writable)
    : undefined;
}

/**
 * Paces a generator: it yields to the event loop every YIELD_AFTER_MS;
 * at each page end it waits until the sheet's zip input has compressed its
 * backlog and the response has room. Rows are produced no faster than the
 * deflate and the client consume them, so memory stays bounded by about a
 * page whatever the export size or the client speed.
 */
export class RowPacer {
  private lastYield = performance.now();

  constructor(
    private readonly out: Writable,
    private readonly signal: AbortSignal,
    private readonly sheet?: ExcelJS.Worksheet,
  ) {}

  async row(): Promise<void> {
    if (performance.now() - this.lastYield < YIELD_AFTER_MS) return;
    await this.yield();
    this.signal.throwIfAborted();
  }

  async pageDone(): Promise<void> {
    await this.yield();
    const zipInput = this.sheet ? sheetZipInput(this.sheet) : undefined;
    if (zipInput) await whenWritable(zipInput, this.signal);
    await whenWritable(this.out, this.signal);
    this.lastYield = performance.now();
  }

  private async yield(): Promise<void> {
    await yieldToEventLoop();
    this.lastYield = performance.now();
  }
}
