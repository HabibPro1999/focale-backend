import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { NetworkingExportsService } from "./networking.exports.service";
const data = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]>, analytics: vi.fn(), expire: vi.fn(), calls: [] as string[] }));
vi.mock("@app/db", () => ({ networkingStore: () => ({ all: async (kind: string) => { data.calls.push(kind); return data.rows[kind] ?? []; } }) }));
vi.mock("./networking.analytics", async (original) => ({ ...(await original<typeof import("./networking.analytics")>()), networkingAnalytics: data.analytics }));

import type { NetworkingSocialService } from "./networking.social.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
const service = new NetworkingExportsService({} as NetworkingSocialService, { expire: data.expire } as unknown as NetworkingMeetingsService);
const event = { id: "event", name: "Test" } as Parameters<typeof service.admin>[0];
describe("networking organizer export contracts", () => {
  beforeEach(() => {
    data.calls = [];
    data.expire.mockReset().mockImplementation(async () => { data.calls.push("expire"); });
    data.analytics.mockReset();
    data.rows = {
      profiles: [{ id: "a", firstName: "=SUM(A1)", lastName: "Person", email: "a@example.test", company: "Acme", status: "ACTIVE" }, { id: "b", firstName: "B", lastName: "Person", company: "Beta" }],
      interests: [{ profileId: "a", targetId: "b" }, { profileId: "a", targetId: "legacy" }],
      audit: [{ actorId: "a", targetId: "b", action: "SWIPE_LIKE" }, { actorId: "a", targetId: "b", action: "SWIPE_PASS" }],
      connections: [{ id: "pair", profileAId: "a", profileBId: "b", createdAt: new Date("2030-01-01Z") }],
      messages: [{ senderId: "a" }],
      meetings: ["CONFIRMED", "COMPLETED", "NO_SHOW", "PENDING", "CANCELLED", "DECLINED", "EXPIRED"].map(status => ({ status, requesterId: "a", recipientId: "b" })),
    };
  });
  it("exports activity history with legacy fallback and the same planned-meeting definition as analytics", async () => {
    const result = await service.admin(event, "participants", "xlsx");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.body as any);
    const sheet = workbook.getWorksheet("participants")!;
    expect(sheet.getRow(1).values).toEqual([undefined, "Name", "Email", "Company", "Role", "Sector", "Status", "Visible", "Last active", "Swipes", "Matches", "Messages", "Planned meetings"]);
    expect([9, 10, 11, 12].map(column => sheet.getRow(2).getCell(column).value)).toEqual([3, 1, 1, 3]);
    expect(sheet.getCell("A2").type).toBe(ExcelJS.ValueType.String);
  });
  it("sorts meeting export rows after expiry and preserves missing table values", async () => {
    data.rows.tables = [{ id: "table", name: "Table 1" }];
    data.rows.meetings = [
      { id: "b", requesterId: "a", recipientId: "unknown", startsAt: new Date("2030-01-01T10:00Z"), endsAt: new Date("2030-01-01T10:30Z"), status: "CONFIRMED", tableId: "missing", message: "" },
      { id: "a", requesterId: "a", recipientId: "b", startsAt: new Date("2030-01-01T10:00Z"), endsAt: new Date("2030-01-01T10:30Z"), status: "CANCELLED", tableId: "table", message: "hello" },
    ];
    const result = await service.admin(event, "meetings", "xlsx");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.body as any);
    const sheet = workbook.getWorksheet("meetings")!;
    expect(sheet.getRow(2).values).toEqual([undefined, "a", "=SUM(A1) Person", "B Person", "2030-01-01T10:00:00.000Z", "2030-01-01T10:30:00.000Z", "Table 1", "CANCELLED", "hello"]);
    expect(sheet.getCell("A3").value).toBe("b");
    expect(sheet.getCell("C3").value).toBe("unknown");
    expect(sheet.getCell("F3").value).toBe("");
    expect(data.calls).toEqual(["profiles", "expire", "meetings", "tables"]);
  });
  it("retains sector headers and aggregate values", async () => {
    data.analytics.mockResolvedValue({ sectors: [{ sector: "Health", participants: 3, matches: 2, meetings: 1 }] });
    const result = await service.admin(event, "sectors", "csv");
    expect(result.body).toBe('\uFEFF"Sector","Participants","Matches","Meetings"\r\n"Health","3","2","1"');
    expect(data.analytics).toHaveBeenCalledWith("event");
    expect(data.calls).toEqual(["profiles"]);
  });
  it("rejects unsupported kind or format before any reads", async () => {
    for (const [kind, format] of [["other", "csv"], ["meetings", "other"]])
      await expect(service.admin(event, kind, format)).rejects.toThrow("Choose participants, matches, meetings or sectors and csv, xlsx or pdf");
    expect(data.calls).toEqual([]);
  });
  it("retains both company columns and neutralizes spreadsheet formula text in CSV", async () => {
    const result = await service.admin(event, "matches", "csv");
    expect(result.body).toContain("Company A");
    expect(result.body).toContain("Company B");
    expect(result.body).toContain("Acme");
    expect(result.body).toContain("Beta");
    expect(result.body).toContain("'=SUM(A1) Person");
  });
});
