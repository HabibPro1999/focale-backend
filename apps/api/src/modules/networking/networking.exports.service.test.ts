import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import type { Readable } from "node:stream";
const data = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));
const pdf = vi.hoisted(() => ({ calls: [] as Array<{ headers: string[]; rows: unknown[][] }> }));
vi.mock("@app/db", async (original) => ({
  networkingMeetingIs: (await original<typeof import("@app/db")>()).networkingMeetingIs,
  networkingStore: () => ({ all: async (kind: string) => data.rows[kind] ?? [] }),
}));
// The PDF generator is where the service hands over its table: the parity
// test below reads the headers and rows from it.
vi.mock("@app/integrations", () => ({
  generateNetworkingReportPdf: vi.fn(async (_title: string, headers: string[], rows: unknown[][]) => {
    pdf.calls.push({ headers, rows });
    return Buffer.from("%PDF");
  }),
}));
import { readBack } from "../../core/exports/__testing__/export-output";
import { NetworkingExportsService } from "./networking.exports.service";
import type { NetworkingAdminService } from "./networking.admin.service";
import type { NetworkingSocialService } from "./networking.social.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
const service = new NetworkingExportsService(
  { analytics: async () => ({ sectors: [{ sector: "Santé", participants: 2, matches: 1, meetings: 3 }, { sector: "=cmd", participants: 0, matches: 0, meetings: 0 }] }) } as unknown as NetworkingAdminService,
  {} as NetworkingSocialService,
  { expire: async () => undefined } as unknown as NetworkingMeetingsService,
);
const event = { id: "event", name: "Test" } as Parameters<typeof service.admin>[0];

/** The XLSX body is a stream generated as it is read (3.7b). */
async function bodyBytes(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("networking organizer export contracts", () => {
  beforeEach(() => {
    pdf.calls = [];
    data.rows = {
      profiles: [{ id: "a", firstName: "=SUM(A1)", lastName: "Person", email: "a@example.test", company: "Acme", status: "ACTIVE", visible: true, lastActiveAt: new Date("2030-01-02Z") }, { id: "b", firstName: "B", lastName: "Person", company: "Beta", visible: false }],
      interests: [{ profileId: "a", targetId: "b" }, { profileId: "a", targetId: "legacy" }],
      audit: [{ actorId: "a", targetId: "b", action: "SWIPE_LIKE" }, { actorId: "a", targetId: "b", action: "SWIPE_PASS" }],
      connections: [{ id: "pair", profileAId: "a", profileBId: "b", createdAt: new Date("2030-01-01Z") }, { id: "gone", profileAId: "a", profileBId: "erased", createdAt: new Date("2030-01-03Z") }],
      messages: [{ senderId: "a" }],
      meetings: ["CONFIRMED", "COMPLETED", "NO_SHOW", "PENDING", "CANCELLED", "DECLINED", "EXPIRED"].map((status, i) => ({ id: `m${i}`, status, requesterId: "a", recipientId: "b", startsAt: new Date(Date.UTC(2030, 0, 5, 9 + (i % 3))), endsAt: new Date(Date.UTC(2030, 0, 5, 10 + (i % 3))), tableId: i % 2 ? "t1" : null, message: i === 1 ? "=HYPERLINK(1)" : null })),
      tables: [{ id: "t1", name: "Table 1" }],
    };
  });
  it("exports activity history with legacy fallback and the same planned-meeting definition as analytics", async () => {
    const result = await service.admin(event, "participants", "xlsx");
    expect(result.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await bodyBytes(result.body)) as any);
    const sheet = workbook.getWorksheet("participants")!;
    expect(sheet.getRow(1).values).toEqual([undefined, "Name", "Email", "Company", "Role", "Sector", "Status", "Visible", "Last active", "Swipes", "Matches", "Messages", "Planned meetings"]);
    expect([9, 10, 11, 12].map(column => sheet.getRow(2).getCell(column).value)).toEqual([3, 2, 1, 3]);
    expect(sheet.getCell("A2").type).toBe(ExcelJS.ValueType.String);
  });
  it("retains both company columns and neutralizes spreadsheet formula text in CSV", async () => {
    const result = await service.admin(event, "matches", "csv");
    expect(result.body).toContain("Company A");
    expect(result.body).toContain("Company B");
    expect(result.body).toContain("Acme");
    expect(result.body).toContain("Beta");
    expect(result.body).toContain("'=SUM(A1) Person");
  });
  // 3.7b output parity: the streamed workbook reads back exactly like the
  // pre-3.7b in-memory one (verbatim below) built from the same table.
  it.each(["participants", "matches", "meetings", "sectors"])("%s XLSX reads back like the in-memory workbook", async (kind) => {
    await service.admin(event, kind, "pdf");
    const [{ headers, rows }] = pdf.calls as [{ headers: string[]; rows: unknown[][] }];
    const legacy = await legacyAdminWorkbook(kind, headers, rows);
    const result = await service.admin(event, kind, "xlsx");
    expect(await readBack(await bodyBytes(result.body))).toEqual(await readBack(legacy));
  });
  it("an empty table still reads back like the in-memory workbook", async () => {
    data.rows = {};
    await service.admin(event, "matches", "pdf");
    const [{ headers, rows }] = pdf.calls as [{ headers: string[]; rows: unknown[][] }];
    expect(rows).toEqual([]);
    const result = await service.admin(event, "matches", "xlsx");
    expect(await readBack(await bodyBytes(result.body))).toEqual(await readBack(await legacyAdminWorkbook("matches", headers, rows)));
  });
});

/** Verbatim pre-3.7b XLSX branch of NetworkingExportsService.admin. */
async function legacyAdminWorkbook(kind: string, headers: string[], rows: unknown[][]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Focale";
    const sheet = workbook.addWorksheet(kind);
    sheet.addRow(headers);
    for (const row of rows) sheet.addRow(row.map((value) => value ?? ""));
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E3A5F" },
    };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length + 1, column: headers.length },
    };
    sheet.columns.forEach((column) => {
      column.width = 24;
      column.alignment = { wrapText: true, vertical: "top" };
    });
    return Buffer.from(await workbook.xlsx.writeBuffer());
}
