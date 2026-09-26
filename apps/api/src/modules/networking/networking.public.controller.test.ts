import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  one: vi.fn(), update: vi.fn(), remove: vi.fn(), all: vi.fn(),
  notifications: vi.fn(), transaction: vi.fn(), delete: vi.fn(),
  store: vi.fn(), upsertPush: vi.fn(), withdraw: vi.fn(),
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  networkingStore: mocks.store,
  networkingTransaction: mocks.transaction,
  listNetworkingNotifications: mocks.notifications,
  withdrawNetworkingProfile: mocks.withdraw,
}));
vi.mock("@app/integrations", async (original) => ({
  ...(await original<typeof import("@app/integrations")>()),
  getStorageProvider: () => ({ delete: mocks.delete }),
}));
import { NetworkingPublicController } from "./networking.public.controller";
import { NetworkingUploadsService } from "./networking.uploads.service";
import type { NetworkingService } from "./networking.service";
import type { NetworkingSocialService } from "./networking.social.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
import type { NetworkingExportsService } from "./networking.exports.service";
import type { FastifyRequest } from "fastify";
const own = "https://storage.test/networking/e/profiles/p/current.webp";
function controller(service: Partial<NetworkingService>, meetings: Partial<NetworkingMeetingsService> = {}) {
  return new NetworkingPublicController(
    new NetworkingUploadsService(), service as NetworkingService,
    {} as NetworkingSocialService, meetings as NetworkingMeetingsService, {} as NetworkingExportsService,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.store.mockReturnValue({
    all: mocks.all,
    one: mocks.one,
    remove: mocks.remove,
    upsertPushSubscription: mocks.upsertPush,
  });
  mocks.transaction.mockImplementation(async (_event, run) => run(mocks, {}));
  mocks.one.mockResolvedValue({ photoUrl: own, overrides: { company: "Current Co" } });
  mocks.all.mockResolvedValue([]);
  mocks.update.mockImplementation(async (_kind, _where, patch) => [patch]);
});

describe("blocks", () => {
  const viewer = {
    id: "viewer-1",
    eventId: "event-1",
    email: "viewer@example.test",
    status: "ACTIVE",
    consent: true,
    withdrawnAt: null,
  };

  function makeProfile(overrides: Record<string, unknown> = {}) {
    return {
      id: "target-1",
      eventId: "event-1",
      email: "target@example.test",
      firstName: "Taylor",
      lastName: "Target",
      company: "Example Org",
      jobTitle: "Researcher",
      sector: "Health",
      status: "ACTIVE",
      consent: true,
      withdrawnAt: null,
      visible: true,
      registrationId: "registration-1",
      ...overrides,
    };
  }

  function setup(
    profile: ReturnType<typeof makeProfile> | null,
    options: { connected?: boolean; swipeEnabled?: boolean; searchEnabled?: boolean } = {},
  ) {
    const ctx = {
      event: { id: "event-1" },
      profile: viewer,
      config: {
        swipeEnabled: options.swipeEnabled ?? true,
        searchEnabled: options.searchEnabled ?? true,
      },
    };
    const row = {
      id: "block-row-1",
      eventId: "event-1",
      profileId: viewer.id,
      targetId: profile?.id ?? "target-1",
    };
    mocks.all.mockResolvedValue([row]);
    mocks.one.mockImplementation(async (name, where) => {
      if (name === "profiles" && where.id === viewer.id) return viewer;
      if (name === "profiles" && where.id === profile?.id) return profile;
      if (name === "connections") {
        return options.connected ? { id: "connection-1" } : null;
      }
      return null;
    });
    const participant = vi.fn().mockResolvedValue(ctx);
    const eligible = vi.fn(
      async (candidate: { status: string; withdrawnAt: Date | null; consent: boolean }) =>
        candidate.status === "ACTIVE" && !candidate.withdrawnAt && candidate.consent,
    );
    const instance = controller({
      participant,
      eligible,
    } as unknown as NetworkingService);
    return { ctx, row, instance, participant, eligible };
  }

  it("returns the public profile for an eligible, visible target", async () => {
    const target = makeProfile();
    const { instance } = setup(target);

    const result = await instance.blocks(
      "event",
      { headers: {} } as FastifyRequest,
    );

    expect(result).toMatchObject({
      total: 1,
      items: [{
        id: "block-row-1",
        targetId: "target-1",
        profile: { id: "target-1", firstName: "Taylor" },
      }],
    });
    expect(mocks.one).toHaveBeenCalledWith("profiles", {
      id: "target-1",
      eventId: "event-1",
    });
  });

  it("keeps a block row with a null profile when the target is missing", async () => {
    const { instance, row } = setup(null);

    const result = await instance.blocks(
      "event",
      { headers: {} } as FastifyRequest,
    );

    expect(result).toEqual({ items: [{ ...row, profile: null }], total: 1 });
  });

  it.each([
    ["ineligible", { consent: false }],
    ["withdrawn", { withdrawnAt: new Date("2026-01-01T00:00:00Z") }],
    ["suspended", { status: "SUSPENDED" }],
  ])("keeps the row but hides an %s target", async (_reason, changes) => {
    const { instance, row } = setup(makeProfile(changes));

    const result = await instance.blocks(
      "event",
      { headers: {} } as FastifyRequest,
    );

    expect(result).toEqual({ items: [{ ...row, profile: null }], total: 1 });
  });

  it.each([
    ["hidden", { visible: false }],
    ["incomplete", { sector: "" }],
  ])("requires a connection before showing an eligible %s target", async (_reason, changes) => {
    const target = makeProfile(changes);
    const disconnected = setup(target);
    const unavailable = await disconnected.instance.blocks(
      "event",
      { headers: {} } as FastifyRequest,
    );
    expect(unavailable.items).toEqual([{ ...disconnected.row, profile: null }]);

    const connected = setup(target, { connected: true });
    const visible = await connected.instance.blocks(
      "event",
      { headers: {} } as FastifyRequest,
    );
    expect(visible.items[0]).toMatchObject({
      targetId: "target-1",
      profile: { id: "target-1", firstName: "Taylor" },
    });
    expect(mocks.one).toHaveBeenCalledWith("connections", {
      eventId: "event-1",
      profileAId: "target-1",
      profileBId: "viewer-1",
    });
  });

  it("hides a matching email identity even when its profile has another ID", async () => {
    const target = makeProfile({ email: "  VIEWER@example.test " });
    const { instance, row } = setup(target, { connected: true });

    const result = await instance.blocks(
      "event",
      { headers: {} } as FastifyRequest,
    );

    expect(result.items).toEqual([{ ...row, profile: null }]);
    expect(mocks.one).not.toHaveBeenCalledWith("connections", expect.anything());
  });

  it("requires a connection while discovery is disabled", async () => {
    const target = makeProfile();
    const disconnected = setup(target, {
      swipeEnabled: false,
      searchEnabled: false,
    });
    const unavailable = await disconnected.instance.blocks(
      "event",
      { headers: {} } as FastifyRequest,
    );
    expect(unavailable.items).toEqual([{ ...disconnected.row, profile: null }]);

    const connected = setup(target, {
      connected: true,
      swipeEnabled: false,
      searchEnabled: false,
    });
    const visible = await connected.instance.blocks(
      "event",
      { headers: {} } as FastifyRequest,
    );
    expect(visible.items[0].profile).toMatchObject({ id: "target-1" });
  });

  it("rejects the viewer's own profile as a block target", async () => {
    mocks.all.mockResolvedValue([{
      id: "block-row-self",
      eventId: "event-1",
      profileId: viewer.id,
      targetId: viewer.id,
    }]);
    const participant = vi.fn().mockResolvedValue({
      event: { id: "event-1" },
      profile: viewer,
      config: { swipeEnabled: true, searchEnabled: true },
    });
    const instance = controller({ participant });

    await expect(
      instance.blocks("event", { headers: {} } as FastifyRequest),
    ).rejects.toMatchObject({
      response: { code: "NETWORKING_VALIDATION" },
    });
  });

  it("denies the block list when the current profile is no longer eligible", async () => {
    const target = makeProfile();
    setup(target);
    const participant = vi.fn().mockResolvedValue({
      event: { id: "event-1" },
      profile: viewer,
      config: { swipeEnabled: true, searchEnabled: true },
    });
    const eligible = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const instanceWithEligibility = controller({
      participant,
      eligible,
    } as unknown as NetworkingService);

    await expect(
      instanceWithEligibility.blocks("event", { headers: {} } as FastifyRequest),
    ).rejects.toMatchObject({
      response: { code: "NETWORKING_NOT_ELIGIBLE" },
    });
    expect(mocks.store).toHaveBeenCalled();
  });

  it("keeps the target ID available to unblock after hiding the profile", async () => {
    const { instance, row } = setup(makeProfile({ withdrawnAt: new Date() }));
    const request = { headers: {} } as FastifyRequest;

    const result = await instance.blocks("event", request);
    expect(result.items[0]).toEqual({ ...row, profile: null });
    await instance.unblock("event", row.targetId, request);

    expect(mocks.remove).toHaveBeenCalledWith("blocks", {
      eventId: "event-1",
      profileId: viewer.id,
      targetId: row.targetId,
    });
  });
});

describe("withdrawal", () => {
  const participant = vi.fn();
  beforeEach(() => participant.mockResolvedValue({
    event: { id: "e", slug: "event" }, profile: { id: "p", photoUrl: "stale.webp", overrides: { company: "Stale Co" } },
  }));
  it("withdraws inside one networking transaction (scrub, deletions and the photo's durable delete live in @app/db)", async () => {
    const tx = { transaction: true };
    mocks.transaction.mockImplementation(async (_event, run) => run(mocks, tx));
    expect(await controller({ participant }).withdraw("event", { headers: {} } as FastifyRequest)).toEqual({ withdrawn: true });
    expect(participant).toHaveBeenCalledWith("event", undefined, { allowConsentPending: true });
    expect(mocks.transaction).toHaveBeenCalledWith("e", expect.any(Function));
    expect(mocks.withdraw).toHaveBeenCalledWith(tx, { eventId: "e", profileId: "p", slug: "event" });
    // Nothing is deleted from storage in the request: the worker's storage.delete handler does it, with retries.
    expect(mocks.delete).not.toHaveBeenCalled();
  });
  it("a failing withdrawal fails the request as a whole (the transaction rolls back)", async () => {
    mocks.withdraw.mockRejectedValue(new Error("outbox unavailable"));
    await expect(controller({ participant }).withdraw("event", { headers: {} } as FastifyRequest)).rejects.toThrow("outbox unavailable");
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});

it("logs out by token only, without resolving a participant context", async () => {
  const logout = vi.fn().mockResolvedValue({ loggedOut: true });
  const participant = vi.fn();
  expect(await controller({ logout, participant }).logout("slug", { headers: { authorization: "Bearer token" } } as FastifyRequest)).toEqual({ loggedOut: true });
  expect(logout).toHaveBeenCalledWith("slug", "Bearer token");
  expect(participant).not.toHaveBeenCalled();
});

it.each(["me", "updateMe"] as const)("%s is on the consent-pending allow-list", async (method) => {
  const participant = vi.fn().mockResolvedValue({ event: { id: "e" }, profile: { id: "p", consent: false } });
  const updateMe = vi.fn().mockResolvedValue({ consent: true });
  const req = { headers: { authorization: "Bearer token" } } as FastifyRequest;
  if (method === "me") expect(await controller({ participant }).me("slug", req)).toEqual({ id: "p", consent: false });
  else await controller({ participant, updateMe }).updateMe("slug", req, { consent: true });
  expect(participant).toHaveBeenCalledWith("slug", "Bearer token", { allowConsentPending: true });
});

it("returns notification data unchanged for participant localization", async () => {
  const payload = { items: [{ id: "n", type: "MEETING_ACCEPT", data: { meetingId: "m", counterpartName: "Alice", startsAt: "2099-01-01T09:00:00Z" } }], total: 1 };
  mocks.notifications.mockResolvedValue(payload);
  const participant = async () => ({ event: { id: "e" }, profile: { id: "p" } });
  expect(await controller({ participant } as never).notifications("event", { headers: {} } as FastifyRequest, { page: 1, limit: 30, sort: "recommended" })).toEqual(payload);
  expect(mocks.notifications).toHaveBeenCalledWith("e", "p", 1, 30);
});

it.each(["connections", "listMeetings"] as const)("%s authenticates the participant (consent required) and forwards pagination unchanged", async (method) => {
  const ctx = { event: { id: "event" }, profile: { id: "self" } };
  const participant = vi.fn().mockResolvedValue(ctx);
  const list = vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null });
  const instance = new NetworkingPublicController(
    {} as NetworkingUploadsService, { participant } as unknown as NetworkingService,
    { connections: list } as unknown as NetworkingSocialService,
    { list } as unknown as NetworkingMeetingsService, {} as NetworkingExportsService,
  );
  const query = { limit: 50, cursor: "opaque" };
  expect(await instance[method]("slug", { headers: { authorization: "Bearer token" } } as FastifyRequest, query)).toEqual({ items: [], total: 0, nextCursor: null });
  expect(participant).toHaveBeenCalledWith("slug", "Bearer token", {});
  expect(list).toHaveBeenCalledWith(ctx, query);
  participant.mockRejectedValueOnce(new Error("ineligible"));
  await expect(instance[method]("slug", { headers: {} } as FastifyRequest, {})).rejects.toThrow("ineligible");
  expect(list).toHaveBeenCalledOnce();
});

it("subscribes a push endpoint with one upsert on the unique endpoint", async () => {
  const participant = async () => ({ event: { id: "e" }, profile: { id: "p" } });
  const row = { id: "sub" };
  mocks.upsertPush.mockResolvedValue(row);
  const body = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "k", auth: "a" }, expirationTime: null };
  expect(await controller({ participant } as never).subscribe("slug", { headers: {} } as FastifyRequest, body as never)).toBe(row);
  expect(mocks.upsertPush).toHaveBeenCalledWith({ eventId: "e", profileId: "p", endpoint: body.endpoint, keys: body.keys, expirationTime: null });
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it("rejects a malformed push endpoint with a coded 400 instead of a TypeError", async () => {
  const participant = async () => ({ event: { id: "e" }, profile: { id: "p" } });
  await expect(controller({ participant } as never).subscribe("slug", { headers: {} } as FastifyRequest, { endpoint: "not a url", keys: { p256dh: "k", auth: "a" } } as never))
    .rejects.toMatchObject({ status: 400, response: { code: "NETWORKING_VALIDATION" } });
});
