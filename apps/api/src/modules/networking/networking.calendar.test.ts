import "reflect-metadata";
import { beforeEach, expect, it, vi } from "vitest";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
const mocks = vi.hoisted(() => ({
  config: vi.fn(), calendarMeetings: vi.fn(), calendarRelations: vi.fn(), one: vi.fn(),
}));
vi.mock("@app/db", async original => ({ ...(await original<typeof import("@app/db")>()),
  getNetworkingConfig: mocks.config, networkingStore: () => mocks,
}));
import { NetworkingAdminService } from "./networking.admin.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingAdminController } from "./networking.admin.controller";
import { AuthGuard } from "../../core/auth/auth.guard";
import { networkingCalendarDay } from "./networking.calendar";
import { NetworkingCalendarDto } from "./networking.dto";
import type { NetworkingService } from "./networking.service";
import type { NetworkingUploadsService } from "./networking.uploads.service";
import type { NetworkingExportsService } from "./networking.exports.service";
import { TENANT_SCOPE, TenantScopeGuard } from "../tenancy/tenant-scope";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockResolvedValue({ timezone: "Europe/Paris" });
  mocks.calendarMeetings.mockResolvedValue([]);
  mocks.calendarRelations.mockResolvedValue({ profiles: [], tables: [], spaces: [] });
});
it.each([
  ["2026-03-29", "Europe/Paris", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z", 23],
  ["2026-10-25", "Europe/Paris", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", 25],
  ["2026-01-01", "Asia/Kathmandu", "2025-12-31T18:15:00.000Z", "2026-01-01T18:15:00.000Z", 24],
  ["2018-11-04", "America/Sao_Paulo", "2018-11-04T03:00:00.000Z", "2018-11-05T02:00:00.000Z", 23],
])("resolves %s in %s with independent local boundaries", (date, zone, start, end, hours) => {
  const result = networkingCalendarDay(date as string, zone as string);
  expect(result.start.toISOString()).toBe(start);
  expect(result.end.toISOString()).toBe(end);
  expect((+result.end - +result.start) / 3600000).toBe(hours);
});
it.each(["", "2026-02-30", "2026-13-01", "2026-2-01", "not-a-date"])("rejects invalid date %s", date => {
  expect(NetworkingCalendarDto.schema.safeParse({ date }).success).toBe(false);
  expect(() => networkingCalendarDay(date, "UTC")).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: "NETWORKING_VALIDATION" }) }));
});
it("rejects a skipped local date and invalid timezone", () => {
  expect(() => networkingCalendarDay("2011-12-30", "Pacific/Apia")).toThrow();
  expect(() => networkingCalendarDay("2026-01-01", "Invalid/Zone")).toThrow();
});
function service() {
  const meetings = new NetworkingMeetingsService({} as NetworkingService);
  const expire = vi.spyOn(meetings, "expire").mockResolvedValue(undefined);
  return { admin: new NetworkingAdminService({} as NetworkingService, meetings), meetings, expire };
}
it("returns the exact admin envelope with profiles, space and representative places using batch hydration", async () => {
  const { admin, expire } = service();
  const row = { id: "m", eventId: "event", requesterId: "a", recipientId: "b", tableId: "table", startsAt: new Date("2026-03-29T09:00Z"), endsAt: new Date("2026-03-29T09:30Z"), status: "CONFIRMED" };
  const a = { id: "a", firstName: "Alice", lastName: "A", company: "A", standTableId: "table" };
  const b = { id: "b", firstName: "Bob", lastName: "B", company: "B" };
  const table = { id: "table", spaceId: "space", ownerProfileId: "b" };
  const space = { id: "space", name: "Hall", location: "First floor" };
  mocks.calendarMeetings.mockResolvedValue([row]);
  mocks.calendarRelations.mockResolvedValue({ profiles: [a, b], tables: [table], spaces: [space] });
  const result = await admin.calendar("event", { date: "2026-03-29", status: "CONFIRMED", tableId: "11111111-1111-4111-8111-111111111111" });
  expect(JSON.parse(JSON.stringify(result))).toEqual({ date: "2026-03-29", timezone: "Europe/Paris", items: [{ ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), requester: a, recipient: b, table: { ...table, space, representativeIds: ["a", "b"], representatives: [a, b].map(({ id, firstName, lastName, company }) => ({ id, firstName, lastName, company })) } }] });
  expect(expire).toHaveBeenCalledWith("event");
  expect(mocks.config).toHaveBeenCalledWith("event");
  expect(mocks.calendarMeetings).toHaveBeenCalledWith("event", new Date("2026-03-28T23:00Z"), new Date("2026-03-29T22:00Z"), { date: "2026-03-29", status: "CONFIRMED", tableId: "11111111-1111-4111-8111-111111111111" });
  expect(mocks.calendarRelations).toHaveBeenCalledWith("event", [row]);
  expect(mocks.one).not.toHaveBeenCalled();
});
it("allows 5000 rows but rejects overflow before hydration, never returning partial data", async () => {
  const { admin, meetings } = service();
  const hydrate = vi.spyOn(meetings, "hydrateCalendar").mockResolvedValue([]);
  mocks.calendarMeetings.mockResolvedValue(Array(5000).fill({}));
  await expect(admin.calendar("event", { date: "2026-01-01" })).resolves.toEqual({ date: "2026-01-01", timezone: "Europe/Paris", items: [] });
  mocks.calendarMeetings.mockResolvedValue(Array(5001).fill({}));
  await expect(admin.calendar("event", { date: "2026-01-01" })).rejects.toMatchObject({ response: { code: "NETWORKING_VALIDATION", message: expect.stringContaining("paginated list") }, status: 400 });
  expect(hydrate).toHaveBeenCalledOnce();
});
it("rejects invalid input before any database calls and does not accept a search parameter", async () => {
  const { admin } = service();
  await expect(admin.calendar("event", { date: "2026-02-30" })).rejects.toMatchObject({ status: 400 });
  expect(mocks.config).not.toHaveBeenCalled();
  expect(NetworkingCalendarDto.schema.parse({ date: "2026-01-01", q: "ignored" })).toEqual({ date: "2026-01-01" });
});
it("keeps organizer auth and event/module isolation, with the static route before meeting IDs", async () => {
  const calendar = vi.fn().mockResolvedValue({ date: "2026-01-01", timezone: "UTC", items: [] });
  const controller = new NetworkingAdminController({} as NetworkingUploadsService, { calendar } as unknown as NetworkingAdminService, {} as NetworkingExportsService);
  const query = { date: "2026-01-01" };
  expect(Reflect.getMetadata(GUARDS_METADATA, NetworkingAdminController)).toContain(AuthGuard);
  expect(Reflect.getMetadata(PATH_METADATA, controller.calendar)).toBe("meetings/calendar");
  const methods = Object.getOwnPropertyNames(NetworkingAdminController.prototype);
  expect(methods.indexOf("calendar")).toBeLessThan(methods.indexOf("updateMeeting"));
  expect(await controller.calendar("event", query)).toEqual({ date: query.date, timezone: "UTC", items: [] });
  expect(Reflect.getMetadata(GUARDS_METADATA, controller.calendar)).toContain(TenantScopeGuard);
  expect(Reflect.getMetadata(TENANT_SCOPE, controller.calendar)).toMatchObject({ kind: "event", modules: ["networking"], write: false });
  expect(calendar).toHaveBeenCalledWith("event", query);
});
