import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerHeartbeat, createWorkerShutdown } from "./lifecycle";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkerHeartbeat", () => {
  it("writes the heartbeat file at start and on every interval, recording the disabled state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "focale-heartbeat-"));
    const file = join(dir, "worker.heartbeat");
    const heartbeat = new WorkerHeartbeat(file, logger(), 20);
    try {
      heartbeat.start({ disabled: true });
      await vi.waitFor(async () => expect((await stat(file)).isFile()).toBe(true));
      const first = JSON.parse(await readFile(file, "utf-8"));
      expect(first).toMatchObject({ pid: process.pid, disabled: true });
      await vi.waitFor(async () => {
        const next = JSON.parse(await readFile(file, "utf-8"));
        expect(next.at).not.toBe(first.at);
      });
    } finally {
      heartbeat.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("logs a failing write once instead of throwing", async () => {
    const log = logger();
    const heartbeat = new WorkerHeartbeat(join(tmpdir(), "missing-dir-focale", "x", "hb"), log, 10);
    heartbeat.start({ disabled: false });
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 40));
    heartbeat.stop();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe("createWorkerShutdown", () => {
  const GRACE = 10_000;

  function harness(overrides: Partial<Parameters<typeof createWorkerShutdown>[0]> = {}) {
    const order: string[] = [];
    const steps = {
      graceMs: GRACE,
      stopRunner: vi.fn(async (_deadline: number) => {
        order.push("runner");
        return { unfinished: [] as string[] };
      }),
      closeContext: vi.fn(async () => void order.push("context")),
      closeDb: vi.fn(async () => void order.push("db")),
      heartbeat: { stop: vi.fn(() => void order.push("heartbeat")) },
      exit: vi.fn((code: number) => void order.push(`exit:${code}`)),
      logger: logger(),
      now: () => 1_000_000,
      ...overrides,
    };
    return { order, steps, shutdown: createWorkerShutdown(steps) };
  }

  it("stops the runner with a deadline of grace − 5 s, then closes the context and the pool", async () => {
    vi.useFakeTimers();
    const { order, steps, shutdown } = harness();
    await shutdown("SIGTERM");
    expect(steps.stopRunner).toHaveBeenCalledWith(1_000_000 + GRACE - 5_000);
    expect(order).toEqual(["runner", "context", "db", "heartbeat", "exit:0"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exits 1 when jobs were still running at the deadline", async () => {
    const { steps, shutdown } = harness({
      stopRunner: vi.fn(async () => ({ unfinished: ["email-queue"] })),
    });
    await shutdown("SIGTERM");
    expect(steps.closeDb).toHaveBeenCalledTimes(1);
    expect(steps.exit).toHaveBeenCalledWith(1);
  });

  it("with jobs disabled (no runner), closes the pool and exits 0", async () => {
    const { order, shutdown } = harness({ stopRunner: undefined, closeContext: undefined });
    await shutdown("SIGTERM");
    expect(order).toEqual(["db", "heartbeat", "exit:0"]);
  });

  it("runs once and hard-exits at grace when a step hangs", async () => {
    vi.useFakeTimers();
    const { steps, shutdown } = harness({ closeDb: () => new Promise(() => undefined) });
    const first = shutdown("SIGTERM");
    expect(shutdown("SIGINT")).toBe(first);
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(steps.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(steps.exit).toHaveBeenCalledWith(1);
    expect(steps.stopRunner).toHaveBeenCalledTimes(1);
  });
});
