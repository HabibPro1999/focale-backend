import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ runOutboxRetention: vi.fn() }));
vi.mock("@app/db", () => db);

import { RetentionJob } from "./retention.job";
import type { JobContext } from "../job";

function ctx(signal: AbortSignal = new AbortController().signal) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { context: { signal, deadline: Date.now() + 300_000, log } as unknown as JobContext, log };
}

beforeEach(() => vi.clearAllMocks());

describe("RetentionJob", () => {
  it("runs hourly within a 5 min budget", () => {
    const job = new RetentionJob();
    expect(job.name).toBe("retention");
    expect(job.intervalMs).toBe(3_600_000);
    expect(job.timeoutMs).toBe(300_000);
  });

  it("passes the job signal and logs only when rows changed", async () => {
    db.runOutboxRetention.mockResolvedValueOnce({ realtimeDeleted: 0, backgroundDeleted: 0, compacted: 0 });
    const controller = new AbortController();
    const quiet = ctx(controller.signal);
    await new RetentionJob().run(quiet.context);
    expect(db.runOutboxRetention).toHaveBeenCalledWith({ signal: controller.signal });
    expect(quiet.log.info).not.toHaveBeenCalled();

    const result = { realtimeDeleted: 1200, backgroundDeleted: 3, compacted: 7 };
    db.runOutboxRetention.mockResolvedValueOnce(result);
    const loud = ctx();
    await new RetentionJob().run(loud.context);
    expect(loud.log.info).toHaveBeenCalledWith({ outbox: result }, "outbox retention");
  });

  it("lets a database failure fail the run", async () => {
    db.runOutboxRetention.mockRejectedValueOnce(new Error("db down"));
    await expect(new RetentionJob().run(ctx().context)).rejects.toThrow("db down");
  });
});
