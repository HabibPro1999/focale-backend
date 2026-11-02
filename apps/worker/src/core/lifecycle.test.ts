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
  it("writes the file and the database row on every beat from one timer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "focale-heartbeat-"));
    const file = join(dir, "worker.heartbeat");
    const record = vi.fn(async () => undefined);
    const jobs = vi.fn(() => ({ outbox: { running: false, timeoutMs: 60_000, overdue: false } }));
    const heartbeat = new WorkerHeartbeat({ file, logger: logger(), record, intervalMs: 20 });
    try {
      heartbeat.start({ disabled: false, jobs });
      await vi.waitFor(async () => expect((await stat(file)).isFile()).toBe(true));
      const first = JSON.parse(await readFile(file, "utf-8"));
      expect(first).toMatchObject({ pid: process.pid, disabled: false });
      expect(record).toHaveBeenCalledWith({
        disabled: false,
        jobs: { outbox: { running: false, timeoutMs: 60_000, overdue: false } },
      });
      await vi.waitFor(async () => {
        const next = JSON.parse(await readFile(file, "utf-8"));
        expect(next.at).not.toBe(first.at);
        expect(record.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      heartbeat.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a disabled worker with no jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "focale-heartbeat-"));
    const record = vi.fn(async () => undefined);
    const heartbeat = new WorkerHeartbeat({ file: join(dir, "hb"), logger: logger(), record });
    try {
      await heartbeat.beat({ disabled: true, jobs: {} });
      expect(record).toHaveBeenCalledWith({ disabled: true, jobs: {} });
      expect(JSON.parse(await readFile(join(dir, "hb"), "utf-8"))).toMatchObject({ disabled: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps touching the file while the database write hangs, without piling up DB writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "focale-heartbeat-"));
    const file = join(dir, "hb");
    const record = vi.fn(() => new Promise<void>(() => undefined));
    const heartbeat = new WorkerHeartbeat({ file, logger: logger(), record });
    try {
      void heartbeat.beat({ disabled: false, jobs: {} });
      await vi.waitFor(async () => expect((await stat(file)).isFile()).toBe(true));
      const before = (await stat(file)).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 20));
      void heartbeat.beat({ disabled: false, jobs: {} });
      await vi.waitFor(async () => expect((await stat(file)).mtimeMs).toBeGreaterThan(before));
      expect(record).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("logs a failing file or database write once per failure streak, and prunes once at start", async () => {
    const log = logger();
    const record = vi.fn(async () => {
      throw new Error("relation worker_heartbeats does not exist");
    });
    const prune = vi.fn(async () => 3);
    const heartbeat = new WorkerHeartbeat({
      file: join(tmpdir(), "missing-dir-focale", "x", "hb"),
      logger: log,
      record,
      prune,
      intervalMs: 10,
    });
    heartbeat.start({ disabled: false });
    await vi.waitFor(() => expect(record.mock.calls.length).toBeGreaterThanOrEqual(3));
    heartbeat.stop();
    expect(log.error).toHaveBeenCalledTimes(2); // one for the file, one for the row
    expect(prune).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ pruned: 3 }, "pruned stale worker heartbeat rows");
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
    expect(order).toEqual(["runner", "context", "heartbeat", "db", "exit:0"]);
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
    expect(order).toEqual(["heartbeat", "db", "exit:0"]);
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
