import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ processOutboxEvents: vi.fn() }));

vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  processOutboxEvents: mocks.processOutboxEvents,
}));

import { REALTIME_OUTBOX_TYPES, type OutboxHandlerRegistry } from "@app/db";
import { RealtimePumpService } from "./realtime.pump";
import type { Config } from "../../core/config";
import { networkingNotificationHub } from "../../core/networking-notification-hub";

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

  it("handles every realtime-scoped type; a networking.notify row wakes exactly its participant's streams (4.3)", async () => {
    vi.useFakeTimers();
    try {
      mocks.processOutboxEvents.mockResolvedValue({ processed: 0, skipped: 0, failed: 0, leaseLost: 0, released: 0 });
      const pump = new RealtimePumpService(makeConfig(false));
      pump.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(1_000);
      const { handlers } = mocks.processOutboxEvents.mock.calls[0]![1] as { handlers: OutboxHandlerRegistry };
      // The realtime scope claims these types; an unhandled one would fail and retry forever.
      expect(Object.keys(handlers).sort()).toEqual([...REALTIME_OUTBOX_TYPES].sort());

      const mine = vi.fn();
      const other = vi.fn();
      const offMine = networkingNotificationHub.subscribe({ eventId: "event-1", profileId: "profile-1" }, mine);
      const offOther = networkingNotificationHub.subscribe({ eventId: "event-1", profileId: "profile-2" }, other);
      try {
        const payload = { eventId: "event-1", profileId: "profile-1", notificationId: "n-1" };
        await expect(Promise.resolve(handlers["networking.notify"]!(payload, { id: "row-1" }))).resolves.toBe("processed");
        expect(mine).toHaveBeenCalledOnce();
        expect(other).not.toHaveBeenCalled();
        // A malformed row is skipped, never retried.
        await expect(Promise.resolve(handlers["networking.notify"]!({ eventId: "event-1" }, { id: "row-2" }))).resolves.toBe("skipped");
        expect(mine).toHaveBeenCalledOnce();
      } finally {
        offMine();
        offOther();
        await pump.beforeApplicationShutdown();
      }
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
