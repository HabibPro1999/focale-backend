import { afterEach, describe, expect, it, vi } from "vitest";

// Keep the real startPoller (the runner's scheduling rides it); only silence
// the loggers.
const logs = vi.hoisted(() => ({ warn: [] as string[], error: [] as string[] }));
vi.mock("@app/shared", async (importOriginal) => {
  const silent = () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn((_details: unknown, message?: string) => void logs.warn.push(message ?? "")),
      error: vi.fn((_details: unknown, message?: string) => void logs.error.push(message ?? "")),
      debug: vi.fn(),
      child: () => logger,
    };
    return logger;
  };
  return {
    ...(await importOriginal<typeof import("@app/shared")>()),
    createLogger: silent,
  };
});

import { JobRunner } from "./job-runner";
import { JobTimeoutError, WorkerShutdownError, type Job, type JobContext } from "./job";

// A controllable job: run() returns a promise you resolve by hand, so a tick
// can be held "in flight" for the overlap-guard / shutdown assertions.
function deferredJob(name: string, intervalMs = 1_000, timeoutMs = 60_000) {
  let resolve!: () => void;
  const contexts: JobContext[] = [];
  const job: Job = {
    name,
    intervalMs,
    timeoutMs,
    run: vi.fn((ctx: JobContext) => {
      contexts.push(ctx);
      return new Promise<void>((r) => {
        resolve = r;
      });
    }),
  };
  return { job, resolveLatest: () => resolve(), contexts };
}

/** A job that ends as soon as its signal aborts (the cooperative case). */
function abortableJob(name: string, intervalMs = 1_000, timeoutMs = 60_000) {
  const contexts: JobContext[] = [];
  const job: Job = {
    name,
    intervalMs,
    timeoutMs,
    run: vi.fn(
      (ctx: JobContext) =>
        new Promise<void>((_, reject) => {
          contexts.push(ctx);
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        }),
    ),
  };
  return { job, contexts };
}

afterEach(() => {
  vi.useRealTimers();
  logs.warn.length = 0;
  logs.error.length = 0;
});

describe("JobRunner", () => {
  it("runs each job once on boot and again on its interval, with ctx.deadline = start + timeoutMs", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const job: Job = { name: "j", intervalMs: 5_000, timeoutMs: 10_000, run: vi.fn().mockResolvedValue(undefined) };
    const runner = new JobRunner([job]);
    runner.start();

    expect(job.run).toHaveBeenCalledTimes(1); // boot tick
    const ctx = vi.mocked(job.run).mock.calls[0]![0];
    expect(ctx.deadline).toBe(1_010_000);
    expect(ctx.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(job.run).toHaveBeenCalledTimes(2);

    await runner.stop();
  });

  it("skips a tick while the previous run is still in flight (overlap guard)", async () => {
    vi.useFakeTimers();
    const { job, resolveLatest } = deferredJob("slow", 1_000);
    const runner = new JobRunner([job]);
    runner.start(); // boot tick starts run #1 (never resolves yet)
    expect(job.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000); // interval fires, but #1 in flight
    expect(job.run).toHaveBeenCalledTimes(1); // skipped

    resolveLatest(); // #1 completes
    await vi.advanceTimersByTimeAsync(1_000); // now a fresh run may start
    expect(job.run).toHaveBeenCalledTimes(2);

    resolveLatest();
    await runner.stop();
  });

  it("aborts a hung run at its timeout and starts no new run until it settles", async () => {
    vi.useFakeTimers();
    const { job, resolveLatest, contexts } = deferredJob("hung", 1_000, 5_000);
    const runner = new JobRunner([job]);
    runner.start();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(contexts[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(contexts[0]!.signal.aborted).toBe(true);
    expect(contexts[0]!.signal.reason).toBeInstanceOf(JobTimeoutError);
    expect(logs.error).toContain("job exceeded its timeout; aborting it (no new run starts until it settles)");

    // The run ignores its signal: still single-flight well past the timeout.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(job.run).toHaveBeenCalledTimes(1);
    expect(runner.snapshot()["hung"]).toMatchObject({ running: true, timeoutMs: 5_000, overdue: true });

    resolveLatest();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(job.run).toHaveBeenCalledTimes(2);
    expect(runner.snapshot()["hung"]).toMatchObject({ running: true, overdue: false, lastOutcome: "timed-out" });

    resolveLatest();
    await runner.stop();
  });

  it("isolates job errors: a throwing job neither escapes nor stops siblings", async () => {
    vi.useFakeTimers();
    const boom: Job = { name: "boom", intervalMs: 1_000, timeoutMs: 60_000, run: vi.fn().mockRejectedValue(new Error("kaboom")) };
    const syncThrow: Job = {
      name: "sync-throw",
      intervalMs: 1_000,
      timeoutMs: 60_000,
      run: vi.fn(() => {
        throw new Error("sync");
      }),
    };
    const healthy: Job = { name: "healthy", intervalMs: 1_000, timeoutMs: 60_000, run: vi.fn().mockResolvedValue(undefined) };
    const runner = new JobRunner([boom, syncThrow, healthy]);

    expect(() => runner.start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(boom.run).toHaveBeenCalledTimes(1);
    expect(healthy.run).toHaveBeenCalledTimes(1);
    expect(runner.snapshot()["boom"]).toMatchObject({ running: false, lastOutcome: "failed" });
    expect(runner.snapshot()["sync-throw"]).toMatchObject({ running: false, lastOutcome: "failed" });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(boom.run).toHaveBeenCalledTimes(2);
    expect(healthy.run).toHaveBeenCalledTimes(2);
    expect(runner.snapshot()["healthy"]).toMatchObject({ lastOutcome: "ok", timeoutMs: 60_000 });

    await runner.stop();
  });

  it("stop() without a deadline awaits an in-flight run and starts nothing new", async () => {
    vi.useFakeTimers();
    const { job, resolveLatest } = deferredJob("draining", 1_000);
    const runner = new JobRunner([job]);
    runner.start();

    let stopped = false;
    const stopPromise = runner.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(false);
    expect(job.run).toHaveBeenCalledTimes(1);

    resolveLatest();
    await stopPromise;
    expect(stopped).toBe(true);
  });
});

describe("JobRunner.stop({ deadline })", () => {
  it("returns as soon as in-flight runs settle, before the deadline, without aborting them", async () => {
    vi.useFakeTimers();
    const { job, resolveLatest, contexts } = deferredJob("quick", 1_000);
    const runner = new JobRunner([job]);
    runner.start();
    const stopping = runner.stop({ deadline: Date.now() + 10_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(contexts[0]!.signal.aborted).toBe(false);
    resolveLatest();
    await expect(stopping).resolves.toEqual({ unfinished: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(job.run).toHaveBeenCalledTimes(1); // no tick after stop
  });

  it("aborts running jobs through their signal at the deadline; cooperative jobs settle", async () => {
    vi.useFakeTimers();
    const { job, contexts } = abortableJob("cooperative");
    const runner = new JobRunner([job]);
    runner.start();
    const stopping = runner.stop({ deadline: Date.now() + 3_000 });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(contexts[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(contexts[0]!.signal.reason).toBeInstanceOf(WorkerShutdownError);
    await expect(stopping).resolves.toEqual({ unfinished: [] });
    expect(runner.snapshot()["cooperative"]).toMatchObject({ running: false, lastOutcome: "aborted" });
    // Nothing is scheduled after stop. (No global timer count: the real poller
    // logger can hold its own timers.)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job.run).toHaveBeenCalledTimes(1);
  });

  it("reports jobs that ignore the abort once the settle window ends", async () => {
    vi.useFakeTimers();
    const { job: stuck } = deferredJob("stuck", 1_000);
    const { job: cooperative } = abortableJob("cooperative");
    const done: Job = { name: "done", intervalMs: 1_000, timeoutMs: 60_000, run: vi.fn().mockResolvedValue(undefined) };
    const runner = new JobRunner([stuck, cooperative, done]);
    runner.start();
    const stopping = runner.stop({ deadline: Date.now() + 3_000, settleMs: 2_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stopping).resolves.toEqual({ unfinished: ["stuck"] });
    expect(logs.error).toContain("jobs ignored the shutdown abort and are still running");
  });
});
