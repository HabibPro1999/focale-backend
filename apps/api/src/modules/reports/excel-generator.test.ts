import ExcelJS from "exceljs";
import JSZip from "jszip";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  withExportStatementTimeout: vi.fn(),
  getEventSummaryData: vi.fn(),
  getReportEventAndAccess: vi.fn(),
  iterateAccessRegistrantsForReport: vi.fn(),
  getSponsorshipsReportData: vi.fn(),
  iterateSponsorshipsForReport: vi.fn(),
  iterateCheckInReportRows: vi.fn(),
}));
vi.mock("@app/db", () => db);

import { collect, useIsolatedTmpdir } from "../../core/exports/__testing__/export-output";
import { ExportAbortedError } from "../../core/exports/stream-io";
import { prepareAccessRegistrantsReport, prepareCheckInReport } from "./excel-generator";

async function loadWorkbook(data: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as Parameters<
      typeof workbook.xlsx.load
    >[0],
  );
  return workbook;
}

// 23:30 UTC on 31 Dec is 00:30 on 1 Jan in Tunis.
const LATE_UTC = new Date("2025-12-31T23:30:00Z");

function registrant(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    referenceNumber: "26-EV-001",
    firstName: "Ana",
    lastName: "Ben Ali",
    email: "ana@example.com",
    phone: null,
    paymentStatus: "PAID",
    totalAmount: 100,
    currency: "TND",
    submittedAt: LATE_UTC,
    checkedInAt: null,
    ...overrides,
  };
}

async function* pages<T>(rows: T[]) {
  if (rows.length > 0) yield rows;
}

/** Export temp directories currently on disk (in this file's private tmpdir). */
const exportTempDirs = useIsolatedTmpdir();

beforeEach(() => {
  vi.clearAllMocks();
  db.withExportStatementTimeout.mockImplementation((run: (tx: unknown) => unknown) => run({}));
});

describe("prepareAccessRegistrantsReport", () => {
  it("gives every access item its own valid, unique sheet", async () => {
    const long = "Atelier de cardiologie interventionnelle";
    db.getReportEventAndAccess.mockResolvedValue({
      event: { slug: "ev", name: "Event" },
      accessItems: [
        { id: "a1", name: `${long} — matin`, type: "WORKSHOP" },
        { id: "a2", name: `${long} — après-midi`, type: "WORKSHOP" },
        { id: "a3", name: "Dîner [gala]: VIP?", type: "DINNER" },
        { id: "a4", name: "ورشة عمل", type: "WORKSHOP" },
      ],
    });
    db.iterateAccessRegistrantsForReport.mockImplementation((_eventId: string, accessId: string) =>
      pages(["a1", "a3"].includes(accessId) ? [registrant({ firstName: "=cmd" })] : []),
    );

    const download = await prepareAccessRegistrantsReport("ev1");
    const workbook = await loadWorkbook(await collect(download));

    expect(download.filename).toMatch(/^ev-acces-inscrits-.*\.xlsx$/);
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      "Atelier de cardiologie interven",
      "Atelier de cardiologie inte (2)",
      "Dîner gala VIP",
      "ورشة عمل",
    ]);
    const first = workbook.worksheets[0]!;
    // Registration date in the event's time zone; names as plain text.
    expect(first.getCell("G2").value).toBe("01/01/2026");
    expect(first.getCell("B2").value).toBe("=cmd");
    expect(first.getCell("B2").type).toBe(ExcelJS.ValueType.String);
    // Each access item reads its own registrants, page by page.
    expect(db.iterateAccessRegistrantsForReport.mock.calls.map((call) => call[1])).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
    ]);
  });

  it("still produces an openable workbook when the event has no access items", async () => {
    db.getReportEventAndAccess.mockResolvedValue({
      event: { slug: "ev", name: "Event" },
      accessItems: [],
    });

    const workbook = await loadWorkbook(await collect(await prepareAccessRegistrantsReport("ev1")));

    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Accès"]);
  });
});

describe("prepareCheckInReport", () => {
  const accessItems = [
    { id: "a1", name: "Atelier A", type: "WORKSHOP" },
    { id: "a2", name: "Atelier: A", type: "WORKSHOP" },
    { id: "a3", name: "ورشة", type: "WORKSHOP" },
    { id: "a4", name: "غداء", type: "MEAL" },
    { id: "a5", name: "Déjeuner", type: "MEAL" },
  ];

  it("writes one ZIP entry per access item, even for duplicate or non-Latin names", async () => {
    db.getReportEventAndAccess.mockResolvedValue({
      event: { slug: "ev", name: "Event" },
      accessItems,
    });
    db.iterateCheckInReportRows.mockImplementation(
      (_eventId: string, scope: { accessId?: string; checkedIn: boolean }) =>
        pages(
          scope.checkedIn && (scope.accessId === undefined || scope.accessId === "a1")
            ? [registrant({ checkedInAt: LATE_UTC })]
            : [],
        ),
    );
    const download = await prepareCheckInReport("ev1");
    const zip = await JSZip.loadAsync(await collect(download), { checkCRC32: true });

    expect(download.contentType).toBe("application/zip");
    expect(download.filename).toMatch(/^ev-checkin-.*\.zip$/);
    expect(Object.keys(zip.files)).toEqual([
      "ev-global-checkin.xlsx",
      "atelier-a-checkin.xlsx",
      "atelier-a-2-checkin.xlsx",
      "access-checkin.xlsx",
      "access-2-checkin.xlsx",
      "dejeuner-checkin.xlsx",
    ]);

    const global = await loadWorkbook(
      await zip.file("ev-global-checkin.xlsx")!.async("nodebuffer"),
    );
    const sheet = global.getWorksheet("Check-in")!;
    // Title, generated-on, blank, header → first data row is 5. Date and time
    // are the event-local 1 Jan 00:30, not the UTC 31 Dec 23:30.
    expect(sheet.getCell("H5").value).toBe("01/01/2026");
    expect(sheet.getCell("I5").value).toBe("00:30");
    // The temp workbooks are gone once the ZIP is out.
    expect(exportTempDirs()).toEqual([]);
  });

  it("removes its temp files when generation fails", async () => {
    db.getReportEventAndAccess.mockResolvedValue({
      event: { slug: "ev", name: "Event" },
      accessItems,
    });
    db.iterateCheckInReportRows.mockImplementation(
      async function* (_eventId: string, scope: { accessId?: string }) {
        if (scope.accessId === "a2") throw new Error("page read failed");
        yield [registrant()];
      },
    );
    const download = await prepareCheckInReport("ev1");
    const out = new PassThrough();
    out.resume();
    await expect(download.write(out, new AbortController().signal)).rejects.toThrow(
      "page read failed",
    );

    expect(exportTempDirs()).toEqual([]);
  });

  it("removes its temp files when the export is aborted mid-way", async () => {
    db.getReportEventAndAccess.mockResolvedValue({
      event: { slug: "ev", name: "Event" },
      accessItems,
    });
    const controller = new AbortController();
    let dirDuringExport: string[] = [];
    db.iterateCheckInReportRows.mockImplementation(
      async function* (_eventId: string, scope: { accessId?: string }) {
        if (scope.accessId === "a3") {
          dirDuringExport = exportTempDirs();
          controller.abort(new ExportAbortedError("client-closed"));
          // A page read that never finishes: the abort alone must end the export.
          await new Promise(() => undefined);
        }
        yield [registrant()];
      },
    );
    const download = await prepareCheckInReport("ev1");
    const out = new PassThrough();
    out.resume();
    await expect(download.write(out, controller.signal)).rejects.toBeInstanceOf(
      ExportAbortedError,
    );

    expect(dirDuringExport).toHaveLength(1);
    expect(existsSync(join(tmpdir(), dirDuringExport[0]!))).toBe(false);
    expect(exportTempDirs()).toEqual([]);
  });
});
