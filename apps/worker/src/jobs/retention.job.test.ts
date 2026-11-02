import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ runOutboxRetention: vi.fn(), runEmailSnapshotRetention: vi.fn() }));
vi.mock("@app/db", () => db);

import { RetentionJob } from "./retention.job";
import type { JobContext } from "../job";

function ctx(signal: AbortSignal = new AbortController().signal) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { context: { signal, deadline: Date.now() + 300_000, log } as unknown as JobContext, log };
}

const QUIET_OUTBOX = { realtimeDeleted: 0, backgroundDeleted: 0, compacted: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  db.runOutboxRetention.mockResolvedValue(QUIET_OUTBOX);
  db.runEmailSnapshotRetention.mockResolvedValue({ cleared: 0, complete: true });
});

describe("RetentionJob", () => {
  it("runs hourly within a 5 min budget", () => {
    const job = new RetentionJob();
    expect(job.name).toBe("retention");
    expect(job.intervalMs).toBe(3_600_000);
    expect(job.timeoutMs).toBe(300_000);
  });

  it("passes the job signal and logs only when rows changed", async () => {
    const controller = new AbortController();
    const quiet = ctx(controller.signal);
    await new RetentionJob().run(quiet.context);
    expect(db.runOutboxRetention).toHaveBeenCalledWith({ signal: controller.signal });
    expect(db.runEmailSnapshotRetention).toHaveBeenCalledWith({ signal: controller.signal, fullPass: true });
    expect(quiet.log.info).not.toHaveBeenCalled();

    const result = { realtimeDeleted: 1200, backgroundDeleted: 3, compacted: 7 };
    db.runOutboxRetention.mockResolvedValueOnce(result);
    db.runEmailSnapshotRetention.mockResolvedValueOnce({ cleared: 40, complete: true });
    const loud = ctx();
    await new RetentionJob().run(loud.context);
    expect(loud.log.info).toHaveBeenCalledWith({ outbox: result }, "outbox retention");
    expect(loud.log.info).toHaveBeenCalledWith(
      { emailSnapshots: { cleared: 40, complete: true, fullPass: true } },
      "email snapshot retention",
    );
  });

  it("sweeps every email snapshot once per process, then only the recent lookback", async () => {
    const job = new RetentionJob();
    // First pass cut short (budget or shutdown): the next run is full again.
    db.runEmailSnapshotRetention.mockResolvedValueOnce({ cleared: 1000, complete: false });
    await job.run(ctx().context);
    await job.run(ctx().context);
    await job.run(ctx().context);
    expect(db.runEmailSnapshotRetention.mock.calls.map(([options]) => options.fullPass)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("lets a database failure fail the run", async () => {
    db.runOutboxRetention.mockRejectedValueOnce(new Error("db down"));
    await expect(new RetentionJob().run(ctx().context)).rejects.toThrow("db down");
    expect(db.runEmailSnapshotRetention).not.toHaveBeenCalled();

    db.runEmailSnapshotRetention.mockRejectedValueOnce(new Error("db down"));
    await expect(new RetentionJob().run(ctx().context)).rejects.toThrow("db down");
  });
});
