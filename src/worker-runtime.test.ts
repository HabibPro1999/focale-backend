import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processOutboxEvents: vi.fn(),
  processEmailQueue: vi.fn(),
  processAbstractBookJobs: vi.fn(),
}));

vi.mock("@/database/client.js", () => ({
  prisma: {
    $disconnect: vi.fn(),
    $queryRaw: vi.fn(),
  },
  getPool: vi.fn(() => null),
}));

vi.mock("@core/outbox", () => ({
  processOutboxEvents: mocks.processOutboxEvents,
}));

vi.mock("@modules/email/index.js", () => ({
  processEmailQueue: mocks.processEmailQueue,
}));

vi.mock("@abstracts", () => ({
  processAbstractBookJobs: mocks.processAbstractBookJobs,
}));

vi.mock("@shared/utils/logger.js", () => ({
  logger: {
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { startWorkerRuntime } from "./worker-runtime.js";

describe("worker runtime", () => {
  it("processes only background outbox events", async () => {
    vi.useFakeTimers();
    try {
      mocks.processOutboxEvents.mockResolvedValue({
        processed: 1,
        skipped: 0,
        failed: 0,
        leaseLost: 0,
      });

      const runtime = startWorkerRuntime();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mocks.processOutboxEvents).toHaveBeenCalledWith(50, {
        workerId: runtime.workerId,
        scope: "background",
      });

      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
