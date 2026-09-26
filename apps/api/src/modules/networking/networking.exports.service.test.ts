import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import type { Readable } from "node:stream";
const data = vi.hoisted(() => ({ pages: {} as Record<string, unknown[][]>, sectors: [] as unknown[], calls: [] as string[] }));
const pdf = vi.hoisted(() => ({ calls: [] as Array<{ headers: string[]; rows: unknown[][] }> }));
// The SQL pages (4.9): each kind yields its fixture rows in pages, as the db generators do.
vi.mock("@app/db", () => {
  const pages = (kind: string) => async function* (eventId: string) {
    data.calls.push(`${kind}:${eventId}`);
    for (const page of data.pages[kind] ?? []) yield page;
  };
  return {
    networkingParticipantExportPages: pages("participants"),
    networkingMatchExportPages: pages("matches"),
    networkingMeetingExportPages: pages("meetings"),
    networkingSectorMetrics: async (eventId: string, options: { unspecified: string }) => {
      data.calls.push(`sectors:${eventId}:${options.unspecified}`);
      return data.sectors;
    },
    networkingStore: () => ({}),
  };
});
// The PDF generator is where the service hands over its table: the parity
// test below reads the headers and rows from it.
vi.mock("@app/integrations", () => ({
  generateNetworkingReportPdf: vi.fn(async (_title: string, headers: string[], rows: unknown[][]) => {
    pdf.calls.push({ headers, rows });
    return Buffer.from("%PDF");
  }),
}));
import { toCsv } from "@app/shared";
import { readBack } from "../../core/exports/__testing__/export-output";
import { NetworkingExportsService } from "./networking.exports.service";
import type { NetworkingSocialService } from "./networking.social.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
const expire = vi.fn(async () => undefined);
const service = new NetworkingExportsService(
  {} as NetworkingSocialService,
  { expire } as unknown as NetworkingMeetingsService,
);
const event = { id: "event", name: "Test" } as Parameters<typeof service.admin>[0];

/** CSV and XLSX bodies are streams generated as they are read (3.7b, 4.9). */
async function bodyBytes(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

const engagement = { swipes: 3, likes: 2, matches: 2, messages: 1, meetings: 3, completedMeetings: 1 };
const none = { swipes: 0, likes: 0, matches: 0, messages: 0, meetings: 0, completedMeetings: 0 };

describe("networking organizer export contracts", () => {
  beforeEach(() => {
    pdf.calls = [];
    data.calls = [];
    expire.mockClear();
    const a = { firstName: "=SUM(A1)", lastName: "Person", company: "Acme" };
    const b = { firstName: "B", lastName: "Person", company: "Beta" };
    data.pages = {
      participants: [
        [{ id: "a", ...a, email: "a@example.test", jobTitle: "", sector: "", status: "ACTIVE", visible: true, lastActiveAt: new Date("2030-01-02Z"), ...engagement }],
        [{ id: "b", ...b, email: "b@example.test", jobTitle: "", sector: "", status: "ACTIVE", visible: false, lastActiveAt: null, ...none }],
      ],
      matches: [[
        { id: "pair", profileAId: "a", profileBId: "b", createdAt: new Date("2030-01-01Z"), a, b },
        { id: "gone", profileAId: "a", profileBId: "erased", createdAt: new Date("2030-01-03Z"), a, b: null },
      ]],
      meetings: [["CONFIRMED", "COMPLETED", "NO_SHOW", "PENDING", "CANCELLED", "DECLINED", "EXPIRED"].map((status, i) => ({
        id: `m${i}`, status, requesterId: "a", recipientId: "b", requester: a, recipient: i === 6 ? null : b,
        startsAt: new Date(Date.UTC(2030, 0, 5, 9 + (i % 3))), endsAt: new Date(Date.UTC(2030, 0, 5, 10 + (i % 3))),
        tableId: i % 2 ? "t1" : null, tableName: i % 2 ? "Table 1" : null, message: i === 1 ? "=HYPERLINK(1)" : "",
      }))],
    };
    data.sectors = [
      { sector: "Santé", participants: 2, connections: 1, meetings: 3 },
      { sector: "=cmd", participants: 0, connections: 0, meetings: 0 },
    ];
  });
  it("exports each participant's engagement from the SQL pages (the analytics definitions)", async () => {
    const result = await service.admin(event, "participants", "xlsx");
    expect(result.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await bodyBytes(result.body)) as any);
    const sheet = workbook.getWorksheet("participants")!;
    expect(sheet.getRow(1).values).toEqual([undefined, "Name", "Email", "Company", "Role", "Sector", "Status", "Visible", "Last active", "Swipes", "Matches", "Messages", "Planned meetings"]);
    expect([9, 10, 11, 12].map(column => sheet.getRow(2).getCell(column).value)).toEqual([3, 2, 1, 3]);
    expect([9, 10, 11, 12].map(column => sheet.getRow(3).getCell(column).value)).toEqual([0, 0, 0, 0]);
    expect(sheet.getCell("A2").type).toBe(ExcelJS.ValueType.String);
    expect(data.calls).toEqual(["participants:event"]);
  });
  it("retains both company columns, names an erased participant by id, and neutralizes spreadsheet formula text in CSV", async () => {
    const result = await service.admin(event, "matches", "csv");
    expect(result.contentType).toBe("text/csv; charset=utf-8");
    const text = (await bodyBytes(result.body)).toString("utf8");
    expect(text).toContain("Company A");
    expect(text).toContain("Company B");
    expect(text).toContain("Acme");
    expect(text).toContain("Beta");
    expect(text).toContain("'=SUM(A1) Person");
    expect(text).toContain('"gone","\'=SUM(A1) Person","Acme","erased","",');
  });
  // 4.9: the streamed CSV is byte for byte the buffered file of 6.3 (BOM, quoting, CRLF).
  it.each(["participants", "matches", "meetings", "sectors"])("%s CSV streams the same bytes as the buffered file", async (kind) => {
    await service.admin(event, kind, "pdf");
    const [{ headers, rows }] = pdf.calls as [{ headers: string[]; rows: unknown[][] }];
    const result = await service.admin(event, kind, "csv");
    expect((await bodyBytes(result.body)).toString("utf8")).toBe(toCsv([headers, ...rows]));
  });
  it("expires stale proposals before the meetings export only", async () => {
    await service.admin(event, "matches", "csv");
    expect(expire).not.toHaveBeenCalled();
    await service.admin(event, "meetings", "csv");
    expect(expire).toHaveBeenCalledWith("event");
  });
  it("names the sectors as the analytics do, from the shared aggregates", async () => {
    await service.admin(event, "sectors", "pdf");
    expect(pdf.calls[0]!.rows).toEqual([["Santé", 2, 1, 3], ["=cmd", 0, 0, 0]]);
    expect(data.calls).toEqual(["sectors:event:Unspecified"]);
  });
  it("rejects an unknown kind or format before reading anything", async () => {
    await expect(service.admin(event, "profiles", "csv")).rejects.toMatchObject({ status: 400 });
    await expect(service.admin(event, "matches", "json")).rejects.toMatchObject({ status: 400 });
    expect(data.calls).toEqual([]);
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
    data.pages = {};
    await service.admin(event, "matches", "pdf");
    const [{ headers, rows }] = pdf.calls as [{ headers: string[]; rows: unknown[][] }];
    expect(rows).toEqual([]);
    const result = await service.admin(event, "matches", "xlsx");
    expect(await readBack(await bodyBytes(result.body))).toEqual(await readBack(await legacyAdminWorkbook("matches", headers, rows)));
    const csv = await service.admin(event, "matches", "csv");
    expect((await bodyBytes(csv.body)).toString("utf8")).toBe(toCsv([headers]));
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
