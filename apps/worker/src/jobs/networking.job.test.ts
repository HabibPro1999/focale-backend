import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ maintain: vi.fn(), delete: vi.fn(), warn: vi.fn() }));
vi.mock("@app/db", () => ({ maintainNetworkingLifecycle: mocks.maintain }));
vi.mock("@app/integrations", async (original) => ({
  ownedStorageKey: (await original<typeof import("@app/integrations")>()).ownedStorageKey,
  getStorageProvider: () => ({ delete: mocks.delete }),
}));
vi.mock("@app/shared", async (original) => ({
  ...(await original<typeof import("@app/shared")>()),
  createLogger: () => ({ warn: mocks.warn }),
}));
import { NetworkingMaintenanceJob } from "./networking.job";
const owned = (id: string) => `https://storage.test/networking/event/profiles/${id}/photo.webp`;
beforeEach(() => vi.resetAllMocks());
it("deletes each purged owned photo, skips absent photos, and continues after storage errors", async () => {
  mocks.maintain.mockImplementation(async (_event, afterPurge) => {
    await afterPurge([
      { id: "a", eventId: "event", photoUrl: owned("a") },
      { id: "b", eventId: "event", photoUrl: owned("b") },
      { id: "c", eventId: "event", photoUrl: owned("c") },
      { id: "d", eventId: "event", photoUrl: null },
    ]);
  });
  mocks.delete.mockRejectedValueOnce(new Error("unavailable"))
    .mockRejectedValueOnce({ code: 404 }).mockResolvedValueOnce(undefined);
  await expect(new NetworkingMaintenanceJob().run()).resolves.toBeUndefined();
  expect(mocks.delete.mock.calls).toEqual(["a", "b", "c"].map((id) => [`networking/event/profiles/${id}/photo.webp`]));
  expect(mocks.warn).toHaveBeenCalledTimes(1);
  expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ profileId: "a" }), expect.any(String));
});

it("never deletes a purged profile's form-supplied, foreign or traversal photo URL", async () => {
  mocks.maintain.mockImplementation(async (_event, afterPurge) => afterPurge([
    { id: "a", eventId: "event", photoUrl: "https://storage.test/forms/uploads/registrant.webp" },
    { id: "b", eventId: "event", photoUrl: owned("a") },
    { id: "c", eventId: "event", photoUrl: "https://storage.test/networking/other/profiles/c/photo.webp" },
    { id: "d", eventId: "event", photoUrl: "https://storage.test/networking/event/profiles/d/../../../../abstracts/final.pdf" },
    { id: "e", eventId: "event", photoUrl: "abstracts/final.pdf" },
  ]));
  await new NetworkingMaintenanceJob().run();
  expect(mocks.delete).not.toHaveBeenCalled();
});

it("bounds concurrent storage deletions to four and drains the remaining photos", async () => {
  const profiles = Array.from({ length: 11 }, (_, i) => ({
    id: String(i), eventId: "event", photoUrl: owned(String(i)),
  }));
  mocks.maintain.mockImplementation(async (_event, afterPurge) => afterPurge(profiles));
  let active = 0;
  let maximum = 0;
  const pending: (() => void)[] = [];
  mocks.delete.mockImplementation(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active--;
  });
  const run = new NetworkingMaintenanceJob().run();
  expect(mocks.delete).toHaveBeenCalledTimes(4);
  for (let completed = 0; completed < profiles.length; completed++) {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    pending.shift()!();
  }
  await run;
  expect(maximum).toBe(4);
  expect(active).toBe(0);
  expect(mocks.delete).toHaveBeenCalledTimes(profiles.length);
});
