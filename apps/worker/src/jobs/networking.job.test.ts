import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ maintain: vi.fn(), delete: vi.fn() }));
vi.mock("@app/db", () => ({ maintainNetworkingLifecycle: mocks.maintain }));
vi.mock("@app/integrations", () => ({ getStorageProvider: () => ({ delete: mocks.delete }) }));
import { NetworkingMaintenanceJob } from "./networking.job";
beforeEach(() => vi.resetAllMocks());

it("runs the lifecycle maintenance for every event and never deletes storage itself", async () => {
  // Purged photos are queued as storage.delete outbox rows in the purge transaction (plan 4.4).
  await expect(new NetworkingMaintenanceJob().run()).resolves.toBeUndefined();
  expect(mocks.maintain).toHaveBeenCalledWith();
  expect(mocks.delete).not.toHaveBeenCalled();
});

it("surfaces a maintenance failure to the job runner", async () => {
  mocks.maintain.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(new NetworkingMaintenanceJob().run()).rejects.toThrow("database unavailable");
});
