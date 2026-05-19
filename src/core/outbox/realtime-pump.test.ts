import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processOutboxEvents: vi.fn(),
}));

vi.mock("./outbox.service.js", () => ({
  processOutboxEvents: mocks.processOutboxEvents,
}));

vi.mock("@shared/utils/logger.js", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { startRealtimeOutboxPump } from "./realtime-pump.js";

describe("realtime outbox pump", () => {
  it("processes only realtime outbox events", async () => {
    vi.useFakeTimers();
    try {
      mocks.processOutboxEvents.mockResolvedValue({
        processed: 1,
        skipped: 0,
        failed: 0,
        leaseLost: 0,
      });

      const pump = startRealtimeOutboxPump();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mocks.processOutboxEvents).toHaveBeenCalledWith(50, {
        workerId: pump.workerId,
        scope: "realtime",
      });

      await pump.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
