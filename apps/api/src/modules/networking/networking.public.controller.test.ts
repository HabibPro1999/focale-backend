import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  one: vi.fn(), update: vi.fn(), remove: vi.fn(), all: vi.fn(),
  notifications: vi.fn(), since: vi.fn(), transaction: vi.fn(), revoke: vi.fn(), delete: vi.fn(),
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  networkingTransaction: mocks.transaction,
  listNetworkingNotifications: mocks.notifications,
  networkingNotificationsSince: mocks.since,
  revokeNetworkingSessions: mocks.revoke,
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
import type { FastifyReply, FastifyRequest } from "fastify";
const own = "https://storage.test/networking/e/profiles/p/current.webp";
function controller(service: Partial<NetworkingService>, meetings: Partial<NetworkingMeetingsService> = {}) {
  return new NetworkingPublicController(
    new NetworkingUploadsService(), service as NetworkingService,
    {} as NetworkingSocialService, meetings as NetworkingMeetingsService, {} as NetworkingExportsService,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (_event, run) => run(mocks, {}));
  mocks.one.mockResolvedValue({ photoUrl: own, overrides: { company: "Current Co" } });
  mocks.all.mockResolvedValue([]);
  mocks.update.mockImplementation(async (_kind, _where, patch) => [patch]);
});

describe("withdrawal", () => {
  const participant = vi.fn();
  beforeEach(() => participant.mockResolvedValue({
    event: { id: "e" }, profile: { id: "p", photoUrl: "stale.webp", overrides: { company: "Stale Co" } },
  }));
  it.each([false, true])("uses the in-transaction row, clears and deletes the owned photo even when storage fails: %s", async (fails) => {
    if (fails) mocks.delete.mockRejectedValue(new Error("storage unavailable"));
    expect(await controller({ participant }).withdraw("event", { headers: {} } as FastifyRequest)).toEqual({ withdrawn: true });
    expect(participant).toHaveBeenCalledWith("event", undefined, { allowConsentPending: true });
    expect(mocks.update).toHaveBeenCalledWith("profiles", { eventId: "e", id: "p" }, expect.objectContaining({
      photoUrl: null, consent: false, visible: false,
      overrides: { company: "Current Co", photoUrl: null, consent: false },
    }));
    expect(mocks.delete).toHaveBeenCalledWith("networking/e/profiles/p/current.webp");
    expect(mocks.revoke).toHaveBeenCalledWith("p", {});
  });
  it.each([
    "https://storage.test/forms/uploads/registrant.webp",
    "https://storage.test/networking/e/profiles/someone-else/photo.webp",
    "https://storage.test/networking/e/profiles/p/../../../../abstracts/final.pdf",
  ])("never deletes a form-supplied or foreign photo URL: %s", async (photoUrl) => {
    mocks.one.mockResolvedValue({ photoUrl, overrides: {} });
    await controller({ participant }).withdraw("event", { headers: {} } as FastifyRequest);
    expect(mocks.delete).not.toHaveBeenCalled();
  });
  it("cancels active meetings, clears their proposals and never names the counterpart", async () => {
    const future = new Date(Date.now() + 3_600_000);
    mocks.all.mockResolvedValue([{ id: "m", requesterId: "p", recipientId: "q", status: "CONFIRMED", endsAt: future, revision: 2, proposedStartsAt: future, proposalBy: "q" }]);
    const notify = vi.fn();
    await controller({ participant }, { notify }).withdraw("event", { headers: {} } as FastifyRequest);
    expect(mocks.update).toHaveBeenCalledWith("meetings", { eventId: "e", id: "m" }, { status: "CANCELLED", revision: 3, proposedStartsAt: null, proposalBy: null });
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.anything(), "MEETING_CANCELLED", ["p", "q"], {}, { counterpart: false });
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

it("rejects a malformed push endpoint with a coded 400 instead of a TypeError", async () => {
  const participant = async () => ({ event: { id: "e" }, profile: { id: "p" } });
  await expect(controller({ participant } as never).subscribe("slug", { headers: {} } as FastifyRequest, { endpoint: "not a url", keys: { p256dh: "k", auth: "a" } } as never))
    .rejects.toMatchObject({ status: 400, response: { code: "NETWORKING_VALIDATION" } });
});

describe("notification stream", () => {
  afterEach(() => vi.useRealTimers());
  it("sends ready, then each row once despite overlapping reads, and re-verifies the session every ~30 s", async () => {
    vi.useFakeTimers();
    const participant = vi.fn().mockResolvedValue({ event: { id: "e" }, profile: { id: "p" } });
    const writes: string[] = [];
    const listeners: Record<string, () => void> = {};
    const raw = { setHeader: vi.fn(), writeHead: vi.fn(), write: vi.fn((chunk: string) => writes.push(chunk)), end: vi.fn(), on: vi.fn((event: string, run: () => void) => { listeners[event] = run; }) };
    const reply = { hijack: vi.fn(), getHeaders: () => ({ "x-request-id": "r" }), raw } as unknown as FastifyReply;
    const createdAt = new Date("2099-04-19T10:00:00.000Z");
    const rows = Object.fromEntries(["one", "two"].map((id) => [id, { id, type: "MESSAGE", title: "New message", body: "…", href: "/e/slug/connections/c", readAt: null, createdAt, data: { connectionId: "c" } }]));
    const row = (id: string) => rows[id]!;
    mocks.since.mockResolvedValueOnce([row("one")]).mockResolvedValueOnce([row("two"), row("one")]).mockResolvedValue([row("two"), row("one")]);
    await controller({ participant }).stream("slug", { headers: {} } as FastifyRequest, reply);
    expect(writes[0]).toBe("event: ready\ndata: {}\n\n");
    for (let tick = 0; tick < 3; tick++) await vi.advanceTimersByTimeAsync(3000);
    const frames = writes.slice(1);
    expect(frames[0]).toBe(`event: notifications\ndata: [{"id":"one","type":"MESSAGE","title":"New message","body":"…","href":"/e/slug/connections/c","readAt":null,"createdAt":"2099-04-19T10:00:00.000Z","data":{"connectionId":"c"}}]\n\n`);
    expect(JSON.parse(frames[1]!.replace(/^event: notifications\ndata: /, "")).map((value: { id: string }) => value.id)).toEqual(["two"]);
    expect(frames[2]).toBe(": heartbeat\n\n");
    const [, , since] = mocks.since.mock.calls[1]!;
    expect(Date.now() - 3000 - (since as Date).getTime()).toBeGreaterThanOrEqual(10_000);
    expect(participant).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(participant).toHaveBeenCalledTimes(2);
    listeners.close?.();
  });
});
