import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_STATUS_COALESCE_MS, coalesceEmailStatusChanges } from "./status-coalescer";

describe("coalesceEmailStatusChanges", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits each email's latest status once per 250 ms window", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const { listener } = coalesceEmailStatusChanges(emit);
    expect(EMAIL_STATUS_COALESCE_MS).toBe(250);

    listener("log-1", "QUEUED");
    listener("log-2", "QUEUED");
    await vi.advanceTimersByTimeAsync(100);
    listener("log-1", "SENDING");
    listener("log-1", "SENT");
    await vi.advanceTimersByTimeAsync(149);
    expect(emit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(emit.mock.calls).toEqual([
      ["log-1", "SENT"],
      ["log-2", "QUEUED"],
    ]);

    // A later change opens a new window.
    listener("log-2", "SENT");
    await vi.advanceTimersByTimeAsync(250);
    expect(emit.mock.calls.at(-1)).toEqual(["log-2", "SENT"]);
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it("emits windows in order, never overlapping a slow emit", async () => {
    const order: string[] = [];
    let release!: () => void;
    const emit = vi.fn(async (id: string, status: string) => {
      if (status === "SENDING") await new Promise<void>((r) => (release = r));
      order.push(`${id}:${status}`);
    });
    const { listener } = coalesceEmailStatusChanges(emit);

    listener("log-1", "SENDING");
    await vi.advanceTimersByTimeAsync(250);
    listener("log-1", "SENT");
    await vi.advanceTimersByTimeAsync(250);
    expect(order).toEqual([]);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["log-1:SENDING", "log-1:SENT"]);
  });

  it("flush emits pending changes at once and waits for them", async () => {
    const emitted: string[] = [];
    const emit = vi.fn(async (id: string, status: string) => {
      emitted.push(`${id}:${status}`);
    });
    const { listener, flush } = coalesceEmailStatusChanges(emit);
    listener("log-1", "FAILED");
    await flush();
    expect(emitted).toEqual(["log-1:FAILED"]);
    // The window's timer was cleared: nothing is emitted twice.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emit).toHaveBeenCalledOnce();
    await expect(flush()).resolves.toBeUndefined();
  });

  it("logs and skips a failing emit without dropping the rest", async () => {
    const emit = vi.fn(async (id: string) => {
      if (id === "log-1") throw new Error("db down");
    });
    const { listener, flush } = coalesceEmailStatusChanges(emit);
    listener("log-1", "SENT");
    listener("log-2", "SENT");
    await flush();
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["log-1", "log-2"]);
  });
});
