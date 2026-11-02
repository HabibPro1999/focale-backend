import { HttpException } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "@app/contracts";
import {
  ShutdownCoordinator,
  createShutdownHandler,
  jitteredReconnectMs,
  shutdownTimeline,
} from "./shutdown";

const GRACE = 10_000;

function harness(
  overrides: { closeApp?: () => Promise<void>; closeDb?: () => Promise<void> } = {},
) {
  const order: string[] = [];
  const steps = {
    graceMs: GRACE,
    startDraining: vi.fn(() => void order.push("drain")),
    closeApp: vi.fn(overrides.closeApp ?? (async () => void order.push("app"))),
    forceCloseConnections: vi.fn(() => void order.push("force")),
    closeDb: vi.fn(overrides.closeDb ?? (async () => void order.push("db"))),
    exit: vi.fn((code: number) => void order.push(`exit:${code}`)),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { order, steps, shutdown: createShutdownHandler(steps) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("shutdownTimeline", () => {
  it("force-closes at grace − 5 s, abandons app.close at grace − 2 s, hard-exits at grace", () => {
    expect(shutdownTimeline(25_000)).toEqual({
      forceCloseAt: 20_000,
      abandonAppCloseAt: 23_000,
      hardExitAt: 25_000,
    });
  });
});

describe("createShutdownHandler", () => {
  it("drains, closes the app, then the pool, then exits 0 with no timer left", async () => {
    vi.useFakeTimers();
    const { order, shutdown } = harness();
    await shutdown("SIGTERM");
    expect(order).toEqual(["drain", "app", "db", "exit:0"]);
    expect(vi.getTimerCount()).toBe(0);
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

  it("force-closes connections at grace − 5 s when the app close is stuck, then finishes", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const { order, steps, shutdown } = harness({
      closeApp: () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push("app");
            resolve();
          };
        }),
    });
    steps.forceCloseConnections.mockImplementation(() => {
      order.push("force");
      release(); // destroying the sockets lets Fastify's close finish
    });
    const pending = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(GRACE - 5_001);
    expect(steps.forceCloseConnections).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(order).toEqual(["drain", "force", "app", "db", "exit:0"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still closes the pool when the app close hangs past grace − 2 s, and exits 1", async () => {
    vi.useFakeTimers();
    const { order, steps, shutdown } = harness({ closeApp: () => new Promise(() => undefined) });
    const pending = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(GRACE - 2_000);
    await pending;
    expect(order).toEqual(["drain", "force", "db", "exit:1"]);
    expect(steps.logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "API close still pending; closing the database pool anyway",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hard-exits at grace when even the pool close hangs", async () => {
    vi.useFakeTimers();
    const { steps, shutdown } = harness({
      closeApp: () => new Promise(() => undefined),
      closeDb: () => new Promise(() => undefined),
    });
    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(steps.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(steps.exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 when the app or the pool close fails", async () => {
    const failingApp = harness({ closeApp: () => Promise.reject(new Error("boom")) });
    await failingApp.shutdown("SIGTERM");
    expect(failingApp.steps.closeDb).toHaveBeenCalledTimes(1);
    expect(failingApp.steps.exit).toHaveBeenCalledWith(1);

    const failingDb = harness({ closeDb: () => Promise.reject(new Error("end failed")) });
    await failingDb.shutdown("SIGINT");
    expect(failingDb.steps.logger.error).toHaveBeenCalledTimes(1);
    expect(failingDb.steps.exit).toHaveBeenCalledWith(1);
  });
});

describe("ShutdownCoordinator", () => {
  function reply() {
    const headers: Record<string, string> = {};
    const fake = {
      header: vi.fn((name: string, value: string) => {
        headers[name] = value;
        return fake;
      }),
    };
    return { reply: fake as unknown as FastifyReply, headers };
  }

  it("accepts streams until draining, then refuses with 503 SRV_5003 and Retry-After", () => {
    const coordinator = new ShutdownCoordinator();
    const open = reply();
    expect(() => coordinator.assertAcceptingStreams(open.reply)).not.toThrow();
    expect(coordinator.draining).toBe(false);

    coordinator.startDraining();
    const refused = reply();
    let error: unknown;
    try {
      coordinator.assertAcceptingStreams(refused.reply);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: ErrorCodes.SERVER_SHUTTING_DOWN,
    });
    expect(refused.headers).toEqual({ "Retry-After": "5" });
  });

  it("drains every tracked stream once with a jittered 1-5 s reconnect, and skips untracked ones", () => {
    const coordinator = new ShutdownCoordinator();
    const a = vi.fn();
    const b = vi.fn();
    const gone = vi.fn();
    coordinator.trackStream(a);
    coordinator.trackStream(b);
    const untrack = coordinator.trackStream(gone);
    untrack();
    expect(coordinator.openStreams).toBe(2);

    coordinator.beforeApplicationShutdown();
    expect(coordinator.draining).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
    for (const [delay] of [...a.mock.calls, ...b.mock.calls]) {
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThan(5_000);
    }
    expect(coordinator.openStreams).toBe(0);
    expect(coordinator.drainStreams()).toBe(0);
  });

  it("shuts down a stream that finishes opening after the drain, on the next tick", async () => {
    const coordinator = new ShutdownCoordinator();
    coordinator.beforeApplicationShutdown();
    const late = vi.fn();
    coordinator.trackStream(late);
    expect(late).not.toHaveBeenCalled(); // the caller finishes its setup first
    await new Promise((resolve) => setImmediate(resolve));
    expect(late).toHaveBeenCalledTimes(1);
    expect(coordinator.openStreams).toBe(0);
  });

  it("keeps draining when one stream's shutdown throws", () => {
    const coordinator = new ShutdownCoordinator();
    const after = vi.fn();
    coordinator.trackStream(() => {
      throw new Error("socket gone");
    });
    coordinator.trackStream(after);
    expect(coordinator.drainStreams()).toBe(2);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("jitters reconnects across 1-5 s", () => {
    expect(jitteredReconnectMs(() => 0)).toBe(1_000);
    expect(jitteredReconnectMs(() => 0.999_999)).toBe(4_999);
  });
});
