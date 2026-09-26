import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { RowPacer, createXlsxWriter, sheetZipInput, workbookZip } from "./xlsx-stream";

// Guard for the two ExcelJS internals the streamed exports rely on (3.7b):
// the workbook's archiver (`zip.abort()`, abandoned on abort) and the stream
// a sheet's XML is zipped from (`sheet.stream.pipes[0]`, which paces
// generation). Exports still work without them, but an aborted export would
// keep zipping and rows could pile up ahead of deflate, so an ExcelJS upgrade
// that moves either must fail here.

/** Whether a write was refused and 'drain' is pending (core or readable-stream). */
function backedUp(stream: Writable): boolean {
  return (
    stream.writableNeedDrain === true ||
    (stream as { _writableState?: { needDrain?: boolean } })._writableState?.needDrain === true
  );
}

describe("ExcelJS streaming internals (xlsx-stream hooks)", () => {
  it("pins exceljs to an exact version, so an upgrade is a deliberate change this suite runs on", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, "../../../package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.exceljs).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exposes the workbook's archiver, and an abort abandons it", () => {
    const out = new PassThrough();
    out.resume();
    const controller = new AbortController();
    const workbook = createXlsxWriter(out, controller.signal);

    const zip = workbookZip(workbook);
    expect(zip).toBeDefined();
    expect(typeof zip!.abort).toBe("function");
    const abort = vi.spyOn(zip!, "abort");

    controller.abort(new Error("client gone"));

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("exposes each sheet's zip input, which backs up when the zip cannot flush", async () => {
    // A client that reads nothing: the zip output fills, then the sheet's
    // entry stream, which is what RowPacer waits on between pages.
    const out = new PassThrough({ highWaterMark: 16 * 1024 });
    const controller = new AbortController();
    const workbook = createXlsxWriter(out, controller.signal);
    const sheet = workbook.addWorksheet("Rows");

    const input = sheetZipInput(sheet);
    expect(input).toBeDefined();
    expect(typeof input!.write).toBe("function");
    expect(backedUp(input!)).toBe(false);

    for (let i = 0; i < 3_000; i++) {
      // Incompressible text, so deflate output really fills the response.
      sheet.addRow([randomBytes(60).toString("hex")]).commit();
      if (i % 500 === 0) await tick();
    }
    for (let i = 0; i < 20; i++) await tick();
    expect(backedUp(input!)).toBe(true);

    // The pacer holds the generator until the zip input has drained.
    const pacer = new RowPacer(out, controller.signal, sheet);
    let paced = false;
    const pageDone = pacer.pageDone().then(() => {
      paced = true;
    });
    for (let i = 0; i < 20; i++) await tick();
    expect(paced).toBe(false);

    out.resume();
    await pageDone;
    expect(backedUp(input!)).toBe(false);
    sheet.commit();
    await workbook.commit();
  });
});
