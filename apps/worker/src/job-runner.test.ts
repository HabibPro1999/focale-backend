import { describe, expect, it, vi } from "vitest";

vi.mock("@app/shared", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { JobRunner } from "./job-runner";
import type { Job } from "./job";

// A controllable job: run() returns a promise you resolve by hand, so a tick
// can be held "in flight" for the overlap-guard / shutdown assertions.
function deferredJob(name: string, intervalMs = 1_000) {
  let resolve!: () => void;
  const runs: Array<Promise<void>> = [];
  const job: Job = {
    name,
    intervalMs,
    run: vi.fn(() => {
      const p = new Promise<void>((r) => {
        resolve = r;
      });
      runs.push(p);
      return p;
    }),
  };
  return { job, resolveLatest: () => resolve(), runs };
}

describe("JobRunner", () => {
  it("runs each job once on boot and again on its interval", async () => {
    vi.useFakeTimers();
    try {
      const job: Job = { name: "j", intervalMs: 5_000, run: vi.fn().mockResolvedValue(undefined) };
      const runner = new JobRunner([job]);
      runner.start();

      expect(job.run).toHaveBeenCalledTimes(1); // boot tick
      await vi.advanceTimersByTimeAsync(5_000);
      expect(job.run).toHaveBeenCalledTimes(2);

      await runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a tick while the previous run is still in flight (overlap guard)", async () => {
    vi.useFakeTimers();
    try {
      const { job, resolveLatest } = deferredJob("slow", 1_000);
      const runner = new JobRunner([job]);
      runner.start(); // boot tick starts run #1 (never resolves yet)
      expect(job.run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000); // interval fires, but #1 in flight
      expect(job.run).toHaveBeenCalledTimes(1); // skipped

      resolveLatest(); // #1 completes
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000); // now a fresh run may start
      expect(job.run).toHaveBeenCalledTimes(2);

      resolveLatest();
      await runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() awaits an in-flight run", async () => {
    vi.useFakeTimers();
    try {
      const { job, resolveLatest } = deferredJob("draining", 1_000);
      const runner = new JobRunner([job]);
      runner.start();
      expect(job.run).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopPromise = runner.stop().then(() => {
        stopped = true;
      });

      await Promise.resolve();
      expect(stopped).toBe(false); // still waiting for the in-flight batch

      resolveLatest();
      await stopPromise;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates job errors: a throwing job neither escapes nor stops siblings", async () => {
    vi.useFakeTimers();
    try {
      const boom: Job = {
        name: "boom",
        intervalMs: 1_000,
        run: vi.fn().mockRejectedValue(new Error("kaboom")),
      };
      const healthy: Job = {
        name: "healthy",
        intervalMs: 1_000,
        run: vi.fn().mockResolvedValue(undefined),
      };
      const runner = new JobRunner([boom, healthy]);

      // Boot ticks fire both; the rejection is swallowed inside tick().
      expect(() => runner.start()).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(boom.run).toHaveBeenCalledTimes(1);
      expect(healthy.run).toHaveBeenCalledTimes(1);

      // The failed job recovers on the next interval (inFlight cleared in finally).
      await vi.advanceTimersByTimeAsync(1_000);
      expect(boom.run).toHaveBeenCalledTimes(2);
      expect(healthy.run).toHaveBeenCalledTimes(2);

      await runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
