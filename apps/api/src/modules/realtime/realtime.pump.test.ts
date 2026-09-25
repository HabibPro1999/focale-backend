import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ processOutboxEvents: vi.fn() }));

vi.mock("@app/db", () => ({
  processOutboxEvents: mocks.processOutboxEvents,
  REALTIME_EMIT_TYPE: "realtime.emit",
}));

import { RealtimePumpService } from "./realtime.pump";
import type { Config } from "../../core/config";

function makeConfig(disabled: boolean): Config {
  return {
    realtime: { disabled, heartbeatMs: 25_000, clientRetryMs: 15_000 },
  } as unknown as Config;
}

describe("RealtimePumpService", () => {
  beforeEach(() => {
    mocks.processOutboxEvents.mockReset();
  });

  it("claims realtime-scoped outbox events every second in drained batches of 100", async () => {
    vi.useFakeTimers();
    try {
      mocks.processOutboxEvents.mockResolvedValue({
        processed: 1,
        skipped: 0,
        failed: 0,
        leaseLost: 0,
        released: 0,
      });

      const pump = new RealtimePumpService(makeConfig(false));
      pump.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(999);
      expect(mocks.processOutboxEvents).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(mocks.processOutboxEvents).toHaveBeenCalledTimes(1);
      const [batch, options] = mocks.processOutboxEvents.mock.calls[0]!;
      expect(batch).toBe(100);
      expect(options).toMatchObject({ workerId: pump.workerId, scope: "realtime" });
      expect(options.drainUntil).toBe(Date.now() + 5_000);
      expect(options.signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.processOutboxEvents).toHaveBeenCalledTimes(2);

      await pump.beforeApplicationShutdown();
      // Shutdown aborts the drain (its rows go back without an attempt charged).
      expect(options.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.processOutboxEvents).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start the pump when realtime is disabled", async () => {
    vi.useFakeTimers();
    try {
      const pump = new RealtimePumpService(makeConfig(true));
      pump.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mocks.processOutboxEvents).not.toHaveBeenCalled();
      await pump.beforeApplicationShutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
