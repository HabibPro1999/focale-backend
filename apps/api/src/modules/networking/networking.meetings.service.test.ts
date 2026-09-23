import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import type { NetworkingRow, NetworkingStore } from "@app/db";
const mocks = vi.hoisted(() => ({ one: vi.fn(), all: vi.fn(), insertAvailability: vi.fn(), allocationMeetings: vi.fn(), allocationReservations: vi.fn(), allocationTableUsage: vi.fn(), update: vi.fn(), remove: vi.fn(), insert: vi.fn(), notify: vi.fn(), summaries: vi.fn() }));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  networkingStore: () => mocks,
  networkingTransaction: async (_id: string, run: Function) => run(mocks, {}),
  createNetworkingNotification: mocks.notify,
  findClientModuleState: vi.fn(),
  listNetworkingConnectionSummaries: mocks.summaries,
  expireNetworkingProposals: vi.fn(),
}));
vi.mock("../clients/module-gates", () => ({ isModuleEnabledForClient: () => true }));
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
  mocks.allocationMeetings.mockResolvedValue([]);
  mocks.allocationReservations.mockResolvedValue([]);
  mocks.allocationTableUsage.mockResolvedValue([]);
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
  it.each(["requesterCheckedInAt", "recipientCheckedInAt"] as const)("refuses to accept a counter-proposal after %s", async (key) => {
    row.proposedStartsAt = new Date(+start + 3_600_000); row.proposalBy = "b";
    row[key] = new Date();
    const reserve = vi.spyOn(service, "reserve");
    await expect(service.respond(ctx, row.id, { action: "ACCEPT" })).rejects.toMatchObject({ status: 409, response: { code: "NETWORKING_MEETING_CHECKED_IN" } });
    expect(reserve).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("the first check-in withdraws a pending counter-proposal", async () => {
    row.startsAt = new Date(Date.now() + 10 * 60_000); row.endsAt = new Date(+row.startsAt + 1_800_000);
    row.proposedStartsAt = new Date(+row.startsAt + 3_600_000); row.proposalBy = "b";
    const checkin = new NetworkingMeetingsService({ currentParticipant: async () => ctx, target: async () => ({ id: "b" }), badgeProfileId: async () => "b" } as unknown as NetworkingService);
    vi.spyOn(checkin, "hydrate").mockImplementation(async (saved) => saved as any);
    const saved = await checkin.checkin(ctx, row.id, "badge");
    expect(saved).toMatchObject({ requesterCheckedInAt: expect.any(Date), proposedStartsAt: null, proposalBy: null, status: "CONFIRMED" });
  });
  it.each([undefined, "", "   "])("preserves the stored note for message %s", async (message) => {
    vi.spyOn(service, "slot").mockReturnValue({ startsAt: start, endsAt: row.endsAt });
    vi.spyOn(service, "availableAt").mockResolvedValue(undefined);
    await service.respond(ctx, row.id, { action: "RESCHEDULE", startsAt: start.toISOString(), message });
    expect(row.message).toBe("Original note");
  });
  it("writes the K5 notification data: action, proposed window and counterpart, with /e/ hrefs", async () => {
    row.proposedStartsAt = new Date("2099-01-01T14:00:00.000Z");
    await service.notify(ctx, row, "MEETING_RESCHEDULE", ["a"], {} as any);
    expect(mocks.notify).toHaveBeenCalledWith({
      eventId: "event", profileId: "a", type: "MEETING_RESCHEDULE", title: "Meeting update",
      body: `Meeting confirmed for ${start.toISOString()}.`, href: "/e/event/agenda",
      data: {
        meetingId: row.id, revision: 1, action: "RESCHEDULE",
        startsAt: start.toISOString(), endsAt: row.endsAt.toISOString(),
        proposedStartsAt: "2099-01-01T14:00:00.000Z", proposedEndsAt: "2099-01-01T14:30:00.000Z",
        counterpartName: "Bob B", status: "CONFIRMED",
      },
    }, {});
  });
  it.each([["MEETING_ACCEPT", "ACCEPT"], ["MEETING_REQUEST_SENT", "REQUEST"], ["MEETING_CANCELLED", "CANCEL"], ["MEETING_NO_SHOW", "NO_SHOW"]])("maps %s to action %s without a proposal window when none is pending", async (type, action) => {
    await service.notify(ctx, row, type, ["a"], {} as any);
    const { data } = mocks.notify.mock.calls[0]![0];
    expect(data).toMatchObject({ action });
    expect(data).not.toHaveProperty("proposedStartsAt");
  });
  it("omits the counterpart for withdrawal-style cancellations", async () => {
    await service.notify(ctx, row, "MEETING_CANCELLED", ["a", "b"], {} as any, { counterpart: false });
    for (const [notification] of mocks.notify.mock.calls) expect(notification.data).not.toHaveProperty("counterpartName");
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
  it("codes a proposal answered by its own author", async () => {
    row.status = "PENDING"; row.expiresAt = new Date(Date.now() + 3_600_000); row.startsAt = new Date(Date.now() + 7_200_000);
    await expect(service.respond(ctx, row.id, { action: "ACCEPT" })).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_ACTION_NOT_ALLOWED" } });
  });
  it("codes another participant's meeting as not found and hydrates own meetings for the viewer", async () => {
    row.requesterId = "x"; row.recipientId = "y";
    await expect(service.get(ctx, row.id)).rejects.toMatchObject({ status: 404, response: { code: "NETWORKING_NOT_FOUND" } });
    row.requesterId = "a";
    const hydrate = vi.mocked(service.hydrate);
    await service.get(ctx, row.id);
    expect(hydrate).toHaveBeenCalledWith(row, mocks, false, ctx);
  });
  it("maps a concurrent unique reservation violation to a slot conflict", async () => {
    vi.spyOn(service, "availableAt").mockResolvedValue(undefined);
    mocks.insert.mockRejectedValue(Object.assign(new Error("duplicate key"), { cause: { code: "23505", constraint: "networking_reservations_resource_key" } }));
    const manual = { ...ctx, config: { ...ctx.config, autoAssignTables: false } };
    await expect(service.reserve(manual, row, start, row.endsAt, mocks as unknown as NetworkingStore)).rejects.toMatchObject({ status: 409, response: { code: "NETWORKING_SLOT_CONFLICT", message: "This slot was just booked; choose another time" } });
    expect(mocks.insert).toHaveBeenCalledWith("reservations", expect.objectContaining({ meetingId: row.id }));
    mocks.insert.mockRejectedValue(new Error("connection reset"));
    await expect(service.reserve(manual, row, start, row.endsAt, mocks as unknown as NetworkingStore)).rejects.toThrow("connection reset");
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
    expect(mocks.notify.mock.calls.map(([notification]) => notification.href)).toEqual(["/e/event/connections/connection", "/e/event/connections/connection"]);
  });
  it("writes the sender name for message notifications", async () => {
    mocks.one.mockImplementation(async (kind) => kind === "connections" ? { id: "connection", profileAId: "a", profileBId: "b" } : null);
    mocks.insert.mockImplementation(async (_kind, values) => ({ id: "message", createdAt: new Date(), ...values }));
    await social().sendMessage(ctx, "connection", "Hello", "key");
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ href: "/e/event/connections/connection", data: { connectionId: "connection", messageId: "message", counterpartName: "Alice A" } }), {});
  });
  it("writes cancellation dates and status when blocking but never names either side", async () => {
    mocks.one.mockImplementation(async (kind) => kind === "profiles" ? target : null);
    mocks.all.mockResolvedValue([row]);
    await social().block(ctx, "b");
    expect(mocks.notify.mock.calls.map(([notification]) => notification.profileId)).toEqual(["a", "b"]);
    for (const [notification] of mocks.notify.mock.calls)
      expect(notification).toMatchObject({ href: "/e/event/agenda", data: { meetingId: row.id, revision: 2, action: "CANCEL", startsAt: start.toISOString(), endsAt: row.endsAt.toISOString(), status: "CANCELLED" } });
    for (const [notification] of mocks.notify.mock.calls) expect(notification.data).not.toHaveProperty("counterpartName");
  });
});


describe("bounded allocation and availability", () => {
  it("saves normalized availability in bulk inside the transaction", async () => {
    await service.saveAvailability(ctx, [start.toISOString(), start.toISOString()]);
    expect(mocks.insertAvailability).toHaveBeenCalledWith([{ eventId: "event", profileId: "a", startsAt: start }]);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("uses candidate windows and historical aggregated table usage without loading history", async () => {
    vi.spyOn(service, "availableAt").mockResolvedValue(undefined);
    mocks.all.mockImplementation(async (kind) => kind === "tables" ? [
      { id: "busy", name: "A", kind: "TABLE" }, { id: "quiet", name: "B", kind: "TABLE" },
    ] : []);
    // Completed meetings remain part of the historical balancing count.
    mocks.allocationTableUsage.mockResolvedValue([{ tableId: "busy", count: 4 }, { tableId: "quiet", count: 0 }]);
    const result = await service.reserve({ ...ctx, config: { ...ctx.config, autoAssignTables: true } }, row, start, row.endsAt, mocks as unknown as NetworkingStore);
    expect(result.tableId).toBe("quiet");
    expect(mocks.allocationMeetings).toHaveBeenCalledWith("event", start, row.endsAt);
    expect(mocks.allocationReservations).toHaveBeenCalledWith("event", start, row.endsAt);
    expect(mocks.allocationTableUsage).toHaveBeenCalledWith("event");
    expect(mocks.all.mock.calls.some(([kind]) => ["meetings", "reservations"].includes(kind))).toBe(false);
  });
});

describe("targeted connection lookups (K2)", () => {
  const summaryRow = { id: "connection", createdAt: start, profile: { id: "b", firstName: "Bob", lastName: "B", email: "bob@example.test", overrides: {} }, lastMessage: null, unreadCount: 0 };
  const lookup = (target: () => Promise<unknown>) =>
    new NetworkingSocialService({ target } as unknown as NetworkingService);
  it("returns the same public summary shape as the list, scoped by the visibility query's id filter", async () => {
    mocks.one.mockImplementation(async (kind, where) => kind === "connections" && where.id === "connection" ? { id: "connection", profileAId: "a", profileBId: "b" } : null);
    mocks.summaries.mockResolvedValue([summaryRow]);
    const result = await lookup(async () => ({ id: "b" })).connectionSummary(ctx, "connection");
    expect(mocks.summaries).toHaveBeenCalledWith("event", "a", ctx.config.eligiblePaymentStatuses, undefined, { connectionId: "connection" });
    expect(result).toMatchObject({ id: "connection", unreadCount: 0, profile: { id: "b", firstName: "Bob" } });
    expect(result.profile).not.toHaveProperty("email");
  });
  it.each([
    ["another pair's connection", { id: "connection", profileAId: "x", profileBId: "y" }, [summaryRow]],
    ["an unknown id", null, [summaryRow]],
    ["a connection hidden by visibility rules", { id: "connection", profileAId: "a", profileBId: "b" }, []],
  ])("404 NETWORKING_NOT_FOUND for %s", async (_label, connection, summaries) => {
    mocks.one.mockImplementation(async (kind) => kind === "connections" ? connection : null);
    mocks.summaries.mockResolvedValue(summaries);
    await expect(lookup(async () => ({ id: "b" })).connectionSummary(ctx, "connection")).rejects.toMatchObject({ status: 404, response: { code: "NETWORKING_NOT_FOUND" } });
  });
  it("connections/with/:profileId resolves the pair or null, never throwing for an unavailable counterpart", async () => {
    mocks.one.mockImplementation(async (kind, where) => kind === "connections" &&
      (where.id === "connection" || (where.profileAId === "a" && where.profileBId === "b")) ? { id: "connection", profileAId: "a", profileBId: "b" } : null);
    mocks.summaries.mockResolvedValue([summaryRow]);
    expect(await lookup(async () => ({ id: "b" })).connectionWith(ctx, "b")).toMatchObject({ id: "connection" });
    expect(await lookup(async () => ({ id: "c" })).connectionWith(ctx, "c")).toBeNull();
    expect(await lookup(async () => ({ id: "a" })).connectionWith(ctx, "a")).toBeNull();
    const { NotFoundException } = await import("@nestjs/common");
    expect(await lookup(async () => { throw new NotFoundException(); }).connectionWith(ctx, "b")).toBeNull();
  });
});
