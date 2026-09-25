import ExcelJS from "exceljs";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  withExportStatementTimeout: vi.fn(),
  getAccessRegistrantsReportData: vi.fn(),
  getCheckInReportData: vi.fn(),
  getEventSummaryData: vi.fn(),
  getSponsorshipsReportData: vi.fn(),
}));
vi.mock("@app/db", () => db);

import { generateAccessRegistrantsReport, generateCheckInReport } from "./excel-generator";

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

function registrant(accessTypeIds: string[], overrides: Record<string, unknown> = {}) {
  return {
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
    accessTypeIds,
    accessCheckIns: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.withExportStatementTimeout.mockImplementation((run: (tx: unknown) => unknown) => run({}));
});

describe("generateAccessRegistrantsReport", () => {
  it("gives every access item its own valid, unique sheet", async () => {
    const long = "Atelier de cardiologie interventionnelle";
    db.getAccessRegistrantsReportData.mockResolvedValue({
      event: { slug: "ev" },
      accessItems: [
        { id: "a1", name: `${long} — matin`, type: "WORKSHOP" },
        { id: "a2", name: `${long} — après-midi`, type: "WORKSHOP" },
        { id: "a3", name: "Dîner [gala]: VIP?", type: "DINNER" },
        { id: "a4", name: "ورشة عمل", type: "WORKSHOP" },
      ],
      registrations: [registrant(["a1", "a3"], { firstName: "=cmd" })],
    });

    const { data } = await generateAccessRegistrantsReport("ev1");
    const workbook = await loadWorkbook(data);

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
  });

  it("still produces an openable workbook when the event has no access items", async () => {
    db.getAccessRegistrantsReportData.mockResolvedValue({
      event: { slug: "ev" },
      accessItems: [],
      registrations: [],
    });

    const { data } = await generateAccessRegistrantsReport("ev1");
    const workbook = await loadWorkbook(data);

    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Accès"]);
  });
});

describe("generateCheckInReport", () => {
  it("writes one ZIP entry per access item, even for duplicate or non-Latin names", async () => {
    db.getCheckInReportData.mockResolvedValue({
      event: { slug: "ev", name: "Event" },
      accessItems: [
        { id: "a1", name: "Atelier A" },
        { id: "a2", name: "Atelier: A" },
        { id: "a3", name: "ورشة" },
        { id: "a4", name: "غداء" },
        { id: "a5", name: "Déjeuner" },
      ],
      registrations: [
        registrant(["a1"], {
          checkedInAt: LATE_UTC,
          accessCheckIns: [{ accessId: "a1", checkedInAt: LATE_UTC }],
        }),
      ],
    });

    const { data } = await generateCheckInReport("ev1");
    const zip = await JSZip.loadAsync(data);

    expect(Object.keys(zip.files).sort()).toEqual(
      [
        "ev-global-checkin.xlsx",
        "atelier-a-checkin.xlsx",
        "atelier-a-2-checkin.xlsx",
        "access-checkin.xlsx",
        "access-2-checkin.xlsx",
        "dejeuner-checkin.xlsx",
      ].sort(),
    );

    const global = await loadWorkbook(
      await zip.file("ev-global-checkin.xlsx")!.async("nodebuffer"),
    );
    const sheet = global.getWorksheet("Check-in")!;
    // Title, generated-on, blank, header → first data row is 5. Date and time
    // are the event-local 1 Jan 00:30, not the UTC 31 Dec 23:30.
    expect(sheet.getCell("H5").value).toBe("01/01/2026");
    expect(sheet.getCell("I5").value).toBe("00:30");
  });
});
