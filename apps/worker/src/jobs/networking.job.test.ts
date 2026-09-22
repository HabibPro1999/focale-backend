import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ maintain: vi.fn(), delete: vi.fn(), warn: vi.fn() }));
vi.mock("@app/db", () => ({ maintainNetworkingLifecycle: mocks.maintain }));
vi.mock("@app/integrations", () => ({
  extractStorageKeyFromUrl: (url: string) => new URL(url).pathname.slice(1),
  getStorageProvider: () => ({ delete: mocks.delete }),
}));
vi.mock("@app/shared", () => ({ createLogger: () => ({ warn: mocks.warn }) }));
import { NetworkingMaintenanceJob } from "./networking.job";
beforeEach(() => vi.resetAllMocks());
it("deletes each purged photo, skips absent photos, and continues after storage errors", async () => {
  mocks.maintain.mockImplementation(async (_event, afterPurge) => {
    await afterPurge([
      { id: "a", photoUrl: "https://storage.test/a.webp" },
      { id: "b", photoUrl: "https://storage.test/b.webp" },
      { id: "c", photoUrl: "https://storage.test/c.webp" },
      { id: "d", photoUrl: null },
    ]);
  });
  mocks.delete.mockRejectedValueOnce(new Error("unavailable"))
    .mockRejectedValueOnce({ code: 404 }).mockResolvedValueOnce(undefined);
  await expect(new NetworkingMaintenanceJob().run()).resolves.toBeUndefined();
  expect(mocks.delete.mock.calls).toEqual([["a.webp"], ["b.webp"], ["c.webp"]]);
  expect(mocks.warn).toHaveBeenCalledTimes(1);
  expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ profileId: "a" }), expect.any(String));
});

it("bounds concurrent storage deletions to four and drains the remaining photos", async () => {
  const profiles = Array.from({ length: 11 }, (_, i) => ({
    id: String(i), photoUrl: `https://storage.test/${i}.webp`,
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
