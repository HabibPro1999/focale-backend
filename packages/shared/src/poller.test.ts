import { afterEach, describe, expect, it, vi } from "vitest";
import { startPoller } from "./poller";

afterEach(() => {
  vi.useRealTimers();
});

describe("startPoller", () => {
  it("runs on the interval and skips a tick while the previous run is in flight", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const work = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const poller = startPoller({ name: "p", intervalMs: 100, work });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(work).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(work).toHaveBeenCalledTimes(2);
    release();
    await poller.stop();
  });

  it("stops scheduling when its signal aborts, and stop() still waits for the in-flight run", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let release!: () => void;
    const work = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const poller = startPoller({ name: "p", intervalMs: 100, work, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(work).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = poller.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("never schedules with an already-aborted signal", async () => {
    vi.useFakeTimers();
    const work = vi.fn(async () => undefined);
    startPoller({ name: "p", intervalMs: 100, work, signal: AbortSignal.abort() });
    await vi.advanceTimersByTimeAsync(500);
    expect(work).not.toHaveBeenCalled();
  });
});
