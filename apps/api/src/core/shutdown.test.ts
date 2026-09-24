import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "./shutdown";

function harness(overrides: { closeApp?: () => Promise<void>; closeDb?: () => Promise<void> } = {}) {
  const order: string[] = [];
  const steps = {
    closeApp: vi.fn(overrides.closeApp ?? (async () => void order.push("app"))),
    closeDb: vi.fn(overrides.closeDb ?? (async () => void order.push("db"))),
    exit: vi.fn((code: number) => void order.push(`exit:${code}`)),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { order, steps, shutdown: createShutdownHandler({ ...steps, appCloseTimeoutMs: 1000 }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdownHandler", () => {
  it("closes the app, then the database pool, then exits 0", async () => {
    const { order, shutdown } = harness();
    await shutdown("SIGTERM");
    expect(order).toEqual(["app", "db", "exit:0"]);
  });

  it("runs once even when SIGTERM and SIGINT both arrive", async () => {
    const { steps, shutdown } = harness();
    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(steps.closeApp).toHaveBeenCalledTimes(1);
    expect(steps.closeDb).toHaveBeenCalledTimes(1);
    expect(steps.exit).toHaveBeenCalledTimes(1);
  });

  it("still closes the pool when the app close fails or hangs", async () => {
    const failing = harness({ closeApp: () => Promise.reject(new Error("boom")) });
    await failing.shutdown("SIGTERM");
    expect(failing.steps.closeDb).toHaveBeenCalledTimes(1);
    expect(failing.steps.exit).toHaveBeenCalledWith(1);

    vi.useFakeTimers();
    const hanging = harness({ closeApp: () => new Promise(() => undefined) });
    const pending = hanging.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(hanging.steps.logger.warn).toHaveBeenCalledTimes(1);
    expect(hanging.steps.closeDb).toHaveBeenCalledTimes(1);
    expect(hanging.steps.exit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exits 1 when the pool close fails", async () => {
    const { steps, shutdown } = harness({ closeDb: () => Promise.reject(new Error("end failed")) });
    await shutdown("SIGINT");
    expect(steps.logger.error).toHaveBeenCalledTimes(1);
    expect(steps.exit).toHaveBeenCalledWith(1);
  });
});
