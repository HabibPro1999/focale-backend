import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
const data = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));
vi.mock("@app/db", async (original) => ({
  networkingMeetingIs: (await original<typeof import("@app/db")>()).networkingMeetingIs,
  networkingStore: () => ({ all: async (kind: string) => data.rows[kind] ?? [] }),
}));
import { NetworkingExportsService } from "./networking.exports.service";
import type { NetworkingAdminService } from "./networking.admin.service";
import type { NetworkingSocialService } from "./networking.social.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
const service = new NetworkingExportsService({} as NetworkingAdminService, {} as NetworkingSocialService, {} as NetworkingMeetingsService);
const event = { id: "event", name: "Test" } as Parameters<typeof service.admin>[0];
describe("networking organizer export contracts", () => {
  beforeEach(() => {
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
  it("retains both company columns and neutralizes spreadsheet formula text in CSV", async () => {
    const result = await service.admin(event, "matches", "csv");
    expect(result.body).toContain("Company A");
    expect(result.body).toContain("Company B");
    expect(result.body).toContain("Acme");
    expect(result.body).toContain("Beta");
    expect(result.body).toContain("'=SUM(A1) Person");
  });
});
