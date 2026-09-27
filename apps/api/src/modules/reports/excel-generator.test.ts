import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { CheckInReportData, SponsorshipReportRow } from "@app/db";

const exportTx = vi.hoisted(() => ({ exportTransaction: true }));
vi.mock("@app/db", () => ({
  withExportStatementTimeout: vi.fn((run: (tx: unknown) => unknown) => run(exportTx)),
  getEventSummaryData: vi.fn(), getAccessRegistrantsReportData: vi.fn(),
  getSponsorshipsReportData: vi.fn(), getCheckInReportData: vi.fn(),
}));
import * as db from "@app/db";
import { generateEventSummary, generateAccessRegistrantsReport, generateSponsorshipsReport, generateCheckInReport } from "./excel-generator";
import { accessItems, event, expectHeader, paidAt, readWorkbook, rowValues, submittedAt, useExportClock } from "../../../tests/reports/exports.test-support";

useExportClock();

describe("event summary XLSX", () => {
  it("preserves sections, access order, all status counts and settled-only seats", async () => {
    vi.mocked(db.getEventSummaryData).mockResolvedValue({
      event: { ...event, name: "=Medical Congress" }, accessTypes: accessItems,
      registrations: ["PAID", "SPONSORED", "WAIVED", "PARTIAL", "VERIFYING", "PENDING", "REFUNDED"].map((paymentStatus, i) => ({
        id: `reg-${i}`, paymentStatus, paymentMethod: null, totalAmount: 1000, sponsorshipAmount: 0,
        accessTypeIds: i < 4 ? ["access-workshop", "removed-access"] : ["access-dinner"],
      })),
    });
    const result = await generateEventSummary("evt");
    expect(result.filename).toBe("medical-congress-summary-2026-06-04.xlsx");
    expect(db.getEventSummaryData).toHaveBeenCalledWith("evt", exportTx);
    const workbook = await readWorkbook(result.data);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Event Report"]);
    const sheet = workbook.worksheets[0];
    expect(sheet.getCell("A1").value).toBe("'=Medical Congress");
    expect(sheet.getCell("A2").value).toBe("Report generated: 04/06/2026");
    expect(sheet.model.merges).toEqual(["A1:C1", "A2:C2", "A4:C4", "A7:C7", "A12:C12", "A23:C23"]);
    expect(rowValues(sheet, 5, 2)).toEqual(["Total Registrations", 7]);
    expect(rowValues(sheet, 8)).toEqual(["Access Type", "Category", "Count"]);
    expect(rowValues(sheet, 9)).toEqual(["Workshop", "WORKSHOP", 4]);
    expect(rowValues(sheet, 10)).toEqual(["Dinner", "OTHER", 3]);
    expect([13, 14, 15, 16, 18, 19, 20, 21].map((n) => rowValues(sheet, n, 2))).toEqual([
      ["Total Confirmed (Paid + Sponsored + Waived)", 3], ["  - Paid", 1],
      ["  - Sponsored", 1], ["  - Waived (speakers / VIPs)", 1],
      ["Verifying", 1], ["Partial", 1], ["Pending", 1], ["Refunded", 1],
    ]);
    expect(rowValues(sheet, 24)).toEqual(["Access Type", "Category", "Confirmed"]);
    expect(rowValues(sheet, 25)).toEqual(["Workshop", "WORKSHOP", 3]);
    expect(rowValues(sheet, 26)).toEqual(["Dinner", "OTHER", 0]);
    expect(sheet.columns.map((c) => c.width)).toEqual([50, 20, 15]);
    expectHeader(sheet.getCell("A4"), 12);
    expect(sheet.getCell("A8").fill).toMatchObject({ fgColor: { argb: "FFD6E4F0" } });
    expect(sheet.getCell("C9").alignment).toEqual({ horizontal: "center" });
  });
});

describe("access registrants XLSX", () => {
  it("sanitizes/truncates sheet names and preserves query row order, labels and text dates", async () => {
    vi.mocked(db.getAccessRegistrantsReportData).mockResolvedValue({
      event, accessItems: [{ ...accessItems[0], name: "Workshop:/[Advanced]*?\\ with a very long title" }, accessItems[1]],
      registrations: [
        { firstName: "=Amina", lastName: null, email: "amina@example.test", phone: "+216123", paymentStatus: "SPONSORED", totalAmount: 2500, submittedAt, accessTypeIds: ["access-workshop"] },
        { firstName: null, lastName: "Ben Ali", email: "b@example.test", phone: null, paymentStatus: "PENDING", totalAmount: 0, submittedAt: paidAt, accessTypeIds: ["access-workshop", "access-dinner"] },
      ],
    });
    const result = await generateAccessRegistrantsReport("evt");
    expect(result.filename).toBe("medical-congress-acces-inscrits-2026-06-04.xlsx");
    expect(db.getAccessRegistrantsReportData).toHaveBeenCalledWith("evt", exportTx);
    const workbook = await readWorkbook(result.data);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(["WorkshopAdvanced with a very lo", "Dinner"]);
    const sheet = workbook.worksheets[0];
    expect(rowValues(sheet, 1)).toEqual(["Nom", "Prénom", "Email", "Téléphone", "Statut de paiement", "Montant", "Date d'inscription"]);
    expect(rowValues(sheet, 2)).toEqual(["", "'=Amina", "amina@example.test", "'+216123", "Sponsorisé", 2500, "03/06/2026"]);
    expect(rowValues(sheet, 3)).toEqual(["Ben Ali", "", "b@example.test", "", "En attente", 0, "04/06/2026"]);
    expect(rowValues(workbook.worksheets[1], 2)).toEqual(rowValues(sheet, 3));
    expect(sheet.columns.map((c) => c.width)).toEqual([20, 20, 35, 18, 20, 12, 18]);
    expect(sheet.getCell("F2").numFmt).toBeUndefined();
    expect(sheet.getCell("G2").type).toBe(3); // Dates are exported as text, not Excel dates.
    expectHeader(sheet.getCell("A1"));
  });

  it("keeps a zero-worksheet workbook when no access items exist", async () => {
    vi.mocked(db.getAccessRegistrantsReportData).mockResolvedValue({ event, accessItems: [], registrations: [] });
    const workbook = await readWorkbook((await generateAccessRegistrantsReport("evt")).data);
    expect(workbook.worksheets).toEqual([]);
  });

  it("keeps the duplicate-sheet failure when truncation collides", async () => {
    vi.mocked(db.getAccessRegistrantsReportData).mockResolvedValue({
      event, accessItems: accessItems.map((a, i) => ({ ...a, name: `${"A".repeat(31)}${i}` })), registrations: [],
    });
    await expect(generateAccessRegistrantsReport("evt")).rejects.toThrow("already exists");
  });
});

describe("sponsorships XLSX", () => {
  it("sorts by lab/newest, repeats case-insensitive lab totals and includes usage details", async () => {
    const sponsorship = (overrides: Partial<SponsorshipReportRow>): SponsorshipReportRow => ({
      code: "SP-1", status: "USED", beneficiaryName: "Amina", beneficiaryEmail: "amina@example.test",
      beneficiaryPhone: "+216123", beneficiaryAddress: "Tunis", coversBasePrice: true,
      coveredAccessIds: ["access-workshop", "removed-access"], totalAmount: 2500, createdAt: submittedAt,
      batch: { labName: "Alpha", contactName: "Lab contact", email: "lab@example.test", phone: null },
      usages: [], ...overrides,
    });
    vi.mocked(db.getSponsorshipsReportData).mockResolvedValue({
      event, currency: "TND", accessItems,
      sponsorships: [
        sponsorship({ code: "Z", batch: { labName: "Zulu", contactName: "Z", email: "z@example.test", phone: null } }),
        sponsorship({ code: "OLD" }),
        sponsorship({ code: "=NEW", totalAmount: 5000, createdAt: paidAt,
          batch: { labName: "alpha", contactName: "Lab contact", email: "lab@example.test", phone: null },
          usages: [
            { amountApplied: 2000, appliedAt: submittedAt, registration: { firstName: "Amina", lastName: "Ben Ali", email: "amina@example.test" } },
            { amountApplied: 500, appliedAt: paidAt, registration: null },
            { amountApplied: 100, appliedAt: paidAt, registration: { firstName: null, lastName: null, email: "anonymous@example.test" } },
          ],
        }),
      ],
    });
    const result = await generateSponsorshipsReport("evt", { status: "USED" });
    expect(result.filename).toBe("medical-congress-sponsorships-2026-06-04.xlsx");
    expect(db.getSponsorshipsReportData).toHaveBeenCalledWith("evt", { status: "USED" }, exportTx);
    const workbook = await readWorkbook(result.data);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Sponsorships"]);
    const sheet = workbook.worksheets[0];
    expect(sheet.model.merges).toEqual(["A1:R1", "A2:R2"]);
    expect(sheet.getCell("A1").value).toBe(event.name);
    expect(sheet.getCell("A2").value).toBe("Report generated: 04/06/2026");
    expect(rowValues(sheet, 4)).toEqual(["Code", "Laboratory", "Contact", "Lab Email", "Lab Phone", "Lab Total Amount", "Beneficiary", "Beneficiary Email", "Beneficiary Phone", "Beneficiary Address", "Amount", "Currency", "Status", "Created At", "Coverage", "Linked Registrations", "Amount Applied", "Applied At"]);
    expect(rowValues(sheet, 5)).toEqual([
      "'=NEW", "alpha", "Lab contact", "lab@example.test", "", 7500, "Amina", "amina@example.test", "'+216123", "Tunis",
      5000, "TND", "USED", "04/06/2026 09:30:00", "Base registration; Workshop",
      "Amina Ben Ali <amina@example.test> | Registration deleted | anonymous@example.test", 2600,
      "03/06/2026 08:15:00 | 04/06/2026 09:30:00 | 04/06/2026 09:30:00",
    ]);
    expect([sheet.getCell("A6").value, sheet.getCell("A7").value]).toEqual(["OLD", "Z"]);
    expect([sheet.getCell("F6").value, sheet.getCell("F7").value]).toEqual([7500, 2500]);
    for (const cell of ["F5", "K5", "Q5"]) expect(sheet.getCell(cell).numFmt).toBe("#,##0");
    expect(sheet.autoFilter).toBe("A4:R4");
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 4 });
    expect(sheet.getCell("P5").alignment).toEqual({ vertical: "top", wrapText: true });
    expect(sheet.columns.map((c) => c.width)).toEqual([16, 28, 24, 28, 18, 18, 28, 28, 18, 30, 14, 12, 14, 22, 40, 40, 16, 24]);
    expectHeader(sheet.getCell("A4"));
  });
});

describe("check-in ZIP and its workbooks", () => {
  const registration = (id: string, overrides: Partial<CheckInReportData["registrations"][number]> = {}): CheckInReportData["registrations"][number] => ({
    id, referenceNumber: id, firstName: "Amina", lastName: "Ben Ali", email: `${id}@example.test`,
    phone: null, paymentStatus: "PAID", checkedInAt: null,
    accessTypeIds: ["access-workshop"], accessCheckIns: [], ...overrides,
  });

  it("includes global and access scopes, sorts checked-in first stably and uses scope-specific dates", async () => {
    vi.mocked(db.getCheckInReportData).mockResolvedValue({
      event, accessItems, registrations: [
        registration("r1", { accessCheckIns: [{ accessId: "access-workshop", checkedInAt: submittedAt }] }),
        registration("r2", { checkedInAt: paidAt }),
        registration("r3", { checkedInAt: submittedAt, paymentStatus: "WAIVED", accessTypeIds: [] }),
        registration("r4", { firstName: "=Formula", lastName: null, referenceNumber: null }),
      ],
    });
    const result = await generateCheckInReport("evt");
    expect(result.filename).toBe("medical-congress-checkin-2026-06-04.zip");
    expect(db.getCheckInReportData).toHaveBeenCalledWith("evt", exportTx);
    const zip = await JSZip.loadAsync(result.data);
    expect(Object.keys(zip.files)).toEqual(["medical-congress-global-checkin.xlsx", "workshop-checkin.xlsx", "dinner-checkin.xlsx"]);
    const sheets = await Promise.all(Object.values(zip.files).map(async (file) => {
      const workbook = await readWorkbook(await file.async("nodebuffer"));
      expect(workbook.worksheets.map((s) => s.name)).toEqual(["Check-in"]);
      const sheet = workbook.worksheets[0];
      expect(sheet.model.merges).toEqual(["A1:I1", "A2:I2"]);
      expect(sheet.getCell("A2").value).toBe("Generated: 04/06/2026");
      expect(rowValues(sheet, 4)).toEqual(["Ref #", "Last Name", "First Name", "Email", "Phone", "Payment Status", "Checked In", "Check-in Date", "Check-in Time"]);
      expect(sheet.autoFilter).toBe("A4:I4");
      expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 4 });
      expect(sheet.columns.map((c) => c.width)).toEqual([14, 20, 20, 34, 18, 20, 12, 16, 12]);
      expectHeader(sheet.getCell("A4"));
      return sheet;
    }));
    expect(sheets.map((s) => s.getCell("A1").value)).toEqual(["Medical Congress — Global Check-in", "Workshop — Check-in", "Dinner — Check-in"]);
    expect([5, 6, 7, 8].map((n) => sheets[0].getCell(n, 4).value)).toEqual(["r2@example.test", "r3@example.test", "r1@example.test", "r4@example.test"]);
    expect(rowValues(sheets[0], 5)).toEqual(["r2", "Ben Ali", "Amina", "r2@example.test", "", "Payé", "✓", "04/06/2026", "09:30"]);
    expect(rowValues(sheets[0], 8)).toEqual(["", "", "'=Formula", "r4@example.test", "", "Payé", "✗", "", ""]);
    expect(sheets[0].getCell("G5").font).toMatchObject({ bold: true, color: { argb: "FF22C55E" } });
    expect(sheets[0].getCell("G7").font).toMatchObject({ bold: true, color: { argb: "FFEF4444" } });
    expect(rowValues(sheets[1], 5)).toEqual(["r1", "Ben Ali", "Amina", "r1@example.test", "", "Payé", "✓", "03/06/2026", "08:15"]);
    expect(sheets[1].getCell("G6").value).toBe("✗");
    expect(sheets[2].rowCount).toBe(4);
  });

  it("keeps last-write-wins for colliding access ZIP entry names", async () => {
    vi.mocked(db.getCheckInReportData).mockResolvedValue({
      event, accessItems: [{ id: "first", name: "Room A" }, { id: "last", name: "Room-A" }],
      registrations: [registration("first", { accessTypeIds: ["first"] }), registration("last", { accessTypeIds: ["last"] })],
    });
    const zip = await JSZip.loadAsync((await generateCheckInReport("evt")).data);
    expect(Object.keys(zip.files)).toEqual(["medical-congress-global-checkin.xlsx", "room-a-checkin.xlsx"]);
    const sheet = (await readWorkbook(await zip.file("room-a-checkin.xlsx")!.async("nodebuffer"))).worksheets[0];
    expect(sheet.getCell("A1").value).toBe("Room-A — Check-in");
    expect(sheet.getCell("A5").value).toBe("last");
    expect(sheet.rowCount).toBe(5);
  });
});
