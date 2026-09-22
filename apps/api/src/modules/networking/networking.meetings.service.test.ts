import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import type { NetworkingRow, NetworkingStore } from "@app/db";
const mocks = vi.hoisted(() => ({ one: vi.fn(), all: vi.fn(), update: vi.fn(), remove: vi.fn(), insert: vi.fn(), notify: vi.fn() }));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  networkingStore: () => mocks,
  networkingTransaction: async (_id: string, run: Function) => run(mocks, {}),
  createNetworkingNotification: mocks.notify,
}));
vi.mock("../clients/module-gates", () => ({ assertClientModuleEnabled: vi.fn() }));
import { NetworkingService, type NetworkingContext } from "./networking.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingSocialService } from "./networking.social.service";
const start = new Date("2099-01-01T09:00:00Z");
const ctx = {
  event: { id: "event", slug: "event", startDate: start, endDate: new Date("2099-01-02Z"), timezone: "UTC" },
  config: NetworkingConfigSchema.parse({ enabled: true, openingHours: [{ date: "2099-01-01", start: "09:00", end: "12:00" }] }),
  profile: { id: "a", firstName: "Alice", lastName: "A", meetingsEnabled: true }, session: { id: "session" },
} as unknown as NetworkingContext;
let row: NetworkingRow<"meetings">;
let service: NetworkingMeetingsService;
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  row = { id: "meeting", eventId: "event", requesterId: "a", recipientId: "b", status: "CONFIRMED", startsAt: start, endsAt: new Date(+start + 1800000), expiresAt: start, revision: 1, message: "Original note", proposedStartsAt: null, proposalBy: null, requesterCheckedInAt: null, recipientCheckedInAt: null } as NetworkingRow<"meetings">;
  mocks.one.mockImplementation(async (kind: string) => kind === "meetings" ? row : kind === "profiles" ? { id: "b", firstName: "Bob", lastName: "B" } : null);
  mocks.all.mockResolvedValue([]);
  mocks.update.mockImplementation(async (_kind, _where, patch) => [row = { ...row, ...patch }]);
  service = new NetworkingMeetingsService({ currentParticipant: async () => ctx, target: async () => ({ id: "b" }) } as unknown as NetworkingService);
  vi.spyOn(service, "hydrate").mockImplementation(async (saved) => saved as any);
});
describe("NetworkingMeetingsService response integrity", () => {
  it.each(["requesterCheckedInAt", "recipientCheckedInAt"] as const)("refuses reschedule after %s", async (key) => {
    row[key] = new Date();
    await expect(service.respond(ctx, row.id, { action: "RESCHEDULE", startsAt: start.toISOString() })).rejects.toMatchObject({ status: 409, response: { code: "NETWORKING_MEETING_CHECKED_IN" } });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("accepting a counter-proposal clears both attendance timestamps", async () => {
    row.proposedStartsAt = start; row.proposalBy = "b";
    row.requesterCheckedInAt = row.recipientCheckedInAt = new Date();
    vi.spyOn(service, "slot").mockReturnValue({ startsAt: start, endsAt: row.endsAt });
    vi.spyOn(service, "reserve").mockResolvedValue({ tableId: null, status: "PENDING_ALLOCATION" });
    await service.respond(ctx, row.id, { action: "ACCEPT" });
    expect(row).toMatchObject({ requesterCheckedInAt: null, recipientCheckedInAt: null });
  });
  it.each([undefined, "", "   "])("preserves the stored note for message %s", async (message) => {
    vi.spyOn(service, "slot").mockReturnValue({ startsAt: start, endsAt: row.endsAt });
    vi.spyOn(service, "availableAt").mockResolvedValue(undefined);
    await service.respond(ctx, row.id, { action: "RESCHEDULE", startsAt: start.toISOString(), message });
    expect(row.message).toBe("Original note");
  });
  it("writes localized-notification inputs alongside compatibility copy", async () => {
    await service.notify(ctx, row, "MEETING_ACCEPT", ["a"], {} as any);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Meeting update", data: expect.objectContaining({ startsAt: start.toISOString(), endsAt: row.endsAt.toISOString(), counterpartName: "Bob B", meetingId: row.id, status: "CONFIRMED" }) }), {});
  });
});
describe("participant error codes", () => {
  it("codes disabled meetings", () => {
    expect(() => service.requireEnabled({ ...ctx, config: { ...ctx.config, meetingsEnabled: false } })).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: "NETWORKING_FEATURE_DISABLED" }) }));
  });
  it("codes invalid slots", () => {
    expect(() => service.slot(ctx, "2000-01-01Z")).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: "NETWORKING_SLOT_INVALID" }) }));
  });
  it("codes slot conflicts", async () => {
    await expect(service.availableAt(ctx, "b", start, mocks as unknown as NetworkingStore)).rejects.toMatchObject({ status: 409, response: { code: "NETWORKING_SLOT_CONFLICT" } });
  });
  it("codes locked meetings", async () => {
    row.status = "COMPLETED";
    await expect(service.respond(ctx, row.id, { action: "CANCEL" })).rejects.toMatchObject({ status: 409, response: { code: "NETWORKING_MEETING_LOCKED" } });
  });
  it("requires a connection before creating a meeting", async () => {
    vi.spyOn(service, "slot").mockReturnValue({ startsAt: start, endsAt: row.endsAt });
    await expect(service.create(ctx, { profileId: "b", startsAt: start.toISOString() })).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_CONNECTION_REQUIRED" } });
  });
  it("codes closed networking inside the transaction", async () => {
    mocks.one.mockImplementation(async (kind) => kind === "events" ? ctx.event : kind === "configs" ? { config: { ...ctx.config, closesAt: "2000-01-01T00:00:00Z" } } : null);
    await expect(new NetworkingService().currentParticipant(ctx, mocks as unknown as NetworkingStore)).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_CLOSED" } });
  });
  it("codes ineligible participants", async () => {
    mocks.one.mockImplementation(async (kind) => kind === "events" ? ctx.event : kind === "configs" ? { config: ctx.config } : kind === "sessions" ? { expiresAt: start } : null);
    await expect(new NetworkingService().currentParticipant(ctx, mocks as unknown as NetworkingStore)).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_NOT_ELIGIBLE" } });
  });
  it("codes disabled chat", async () => {
    await expect(new NetworkingSocialService({} as NetworkingService).messages({ ...ctx, config: { ...ctx.config, chatEnabled: false } }, "connection")).rejects.toMatchObject({ response: { code: "NETWORKING_FEATURE_DISABLED" } });
  });
});

describe("NetworkingSocialService notification data", () => {
  const target = { id: "b", firstName: "Bob", lastName: "B" };
  const social = () => new NetworkingSocialService({ currentParticipant: async () => ctx, target: async () => target } as unknown as NetworkingService);
  it("writes counterpart names and connection IDs for matches", async () => {
    mocks.one.mockImplementation(async (kind, where) => kind === "interests" && where.profileId === "b" ? { action: "LIKE" } : null);
    mocks.insert.mockImplementation(async (_kind, values) => ({ id: "connection", ...values }));
    await social().interest(ctx, "b", "LIKE");
    expect(mocks.notify.mock.calls.map(([notification]) => notification.data)).toEqual([
      { connectionId: "connection", counterpartName: "Bob B" },
      { connectionId: "connection", counterpartName: "Alice A" },
    ]);
  });
  it("writes the sender name for message notifications", async () => {
    mocks.one.mockImplementation(async (kind) => kind === "connections" ? { id: "connection", profileAId: "a", profileBId: "b" } : null);
    mocks.insert.mockImplementation(async (_kind, values) => ({ id: "message", createdAt: new Date(), ...values }));
    await social().sendMessage(ctx, "connection", "Hello", "key");
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ data: { connectionId: "connection", messageId: "message", counterpartName: "Alice A" } }), {});
  });
  it("writes cancellation dates, status and counterpart names when blocking", async () => {
    mocks.one.mockImplementation(async (kind) => kind === "profiles" ? target : null);
    mocks.all.mockResolvedValue([row]);
    await social().block(ctx, "b");
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ profileId: "a", data: expect.objectContaining({ meetingId: row.id, startsAt: start.toISOString(), status: "CANCELLED", counterpartName: "Bob B" }) }), {});
  });
});
