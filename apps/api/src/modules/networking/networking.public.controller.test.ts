import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  one: vi.fn(), update: vi.fn(), remove: vi.fn(), all: vi.fn(),
  notifications: vi.fn(), transaction: vi.fn(), revoke: vi.fn(), delete: vi.fn(),
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  networkingTransaction: mocks.transaction,
  listNetworkingNotifications: mocks.notifications,
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
import type { FastifyRequest } from "fastify";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (_event, run) => run(mocks, {}));
  mocks.one.mockResolvedValue({ photoUrl: "https://storage.test/current.webp" });
  mocks.all.mockResolvedValue([]);
});
it.each([false, true])("withdrawal clears and deletes the current photo even when storage fails: %s", async (fails) => {
  if (fails) mocks.delete.mockRejectedValue(new Error("storage unavailable"));
  const controller = new NetworkingPublicController(
    new NetworkingUploadsService(),
    { participant: async () => ({ event: { id: "e" }, profile: { id: "p", photoUrl: "stale.webp", overrides: {} } }) } as unknown as NetworkingService,
    {} as NetworkingSocialService, {} as NetworkingMeetingsService, {} as NetworkingExportsService,
  );
  expect(await controller.withdraw("event", { headers: {} } as FastifyRequest)).toEqual({ withdrawn: true });
  expect(mocks.update).toHaveBeenCalledWith("profiles", { eventId: "e", id: "p" }, expect.objectContaining({ photoUrl: null, consent: false, visible: false }));
  expect(mocks.delete).toHaveBeenCalledWith("current.webp");
  expect(mocks.revoke).toHaveBeenCalledWith("p", {});
});

it("returns notification data unchanged for participant localization", async () => {
  const payload = { items: [{ id: "n", type: "MEETING_ACCEPT", data: { meetingId: "m", counterpartName: "Alice", startsAt: "2099-01-01T09:00:00Z" } }], total: 1 };
  mocks.notifications.mockResolvedValue(payload);
  const controller = new NetworkingPublicController(
    new NetworkingUploadsService(),
    { participant: async () => ({ event: { id: "e" }, profile: { id: "p" } }) } as unknown as NetworkingService,
    {} as NetworkingSocialService, {} as NetworkingMeetingsService, {} as NetworkingExportsService,
  );
  expect(await controller.notifications("event", { headers: {} } as FastifyRequest, { page: 1, limit: 30, sort: "recommended" })).toEqual(payload);
  expect(mocks.notifications).toHaveBeenCalledWith("e", "p", 1, 30);
});
