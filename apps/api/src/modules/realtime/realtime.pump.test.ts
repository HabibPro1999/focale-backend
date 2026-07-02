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

  it("claims realtime-scoped outbox events every 5s", async () => {
    vi.useFakeTimers();
    try {
      mocks.processOutboxEvents.mockResolvedValue({
        processed: 1,
        skipped: 0,
        failed: 0,
        leaseLost: 0,
      });

      const pump = new RealtimePumpService(makeConfig(false));
      pump.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mocks.processOutboxEvents).toHaveBeenCalledWith(
        50,
        expect.objectContaining({ workerId: pump.workerId, scope: "realtime" }),
      );

      await pump.onApplicationShutdown();
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
      await pump.onApplicationShutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
