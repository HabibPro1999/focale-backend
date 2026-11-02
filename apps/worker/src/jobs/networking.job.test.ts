import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ maintain: vi.fn(), delete: vi.fn(), deliver: vi.fn() }));
vi.mock("@app/db", () => ({ maintainNetworkingLifecycle: mocks.maintain }));
vi.mock("@app/integrations", () => ({
  getStorageProvider: () => ({ delete: mocks.delete }),
  NETWORKING_DELIVERY_INTERVAL_MS: 1_000,
  networkingDeliveryWorkerOptions: () => ({ runBudgetMs: 15_000 }),
  processNetworkingDeliveries: mocks.deliver,
}));
vi.mock("../core/config", () => ({ loadConfig: () => ({ NETWORKING_WITHDRAWAL_ERASE_DAYS: 12 }) }));
import { NetworkingDeliveryJob, NetworkingMaintenanceJob } from "./networking.job";
import type { JobContext } from "../job";
beforeEach(() => vi.resetAllMocks());

it("runs the lifecycle maintenance for every event with the configured erase window, and never deletes storage itself", async () => {
  // Purged photos are queued as storage.delete outbox rows in the purge transaction (plan 4.4).
  await expect(new NetworkingMaintenanceJob().run()).resolves.toBeUndefined();
  expect(mocks.maintain).toHaveBeenCalledWith(undefined, { withdrawalEraseDays: 12 });
  expect(mocks.delete).not.toHaveBeenCalled();
});

it("surfaces a maintenance failure to the job runner", async () => {
  mocks.maintain.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(new NetworkingMaintenanceJob().run()).rejects.toThrow("database unavailable");
});

it("runs the delivery lanes every second and stops claiming well before the job timeout", async () => {
  mocks.deliver.mockResolvedValue({ sent: 1, skipped: 0, failed: 0, uncertain: 0, deferred: 0 });
  const job = new NetworkingDeliveryJob();
  expect(job.intervalMs).toBe(1_000);
  const signal = new AbortController().signal;
  const now = Date.now();
  await job.run({ signal, deadline: now + job.timeoutMs } as JobContext);
  const [{ signal: passed, until }] = mocks.deliver.mock.calls[0] as [{ signal: AbortSignal; until: number }];
  expect(passed).toBe(signal);
  // min(now + run budget, deadline - 15 s margin)
  expect(until).toBeLessThanOrEqual(now + job.timeoutMs - 15_000);
  expect(until).toBeGreaterThanOrEqual(now + 14_000);
});
