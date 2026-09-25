import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  outboxQueue: { spec: { name: "outbox:all" }, recoverStale: vi.fn() },
}));
vi.mock("@app/db", () => db);

import { LeaseRecoveryJob, recoverableQueues } from "./lease-recovery.job";
import type { JobContext } from "../job";

function ctx(signal: AbortSignal = new AbortController().signal) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { context: { signal, deadline: Date.now() + 60_000, log } as unknown as JobContext, log };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LeaseRecoveryJob", () => {
  it("recovers the outbox queue every 30 s within a 60 s budget", () => {
    const job = new LeaseRecoveryJob();
    expect(job.name).toBe("lease-recovery");
    expect(job.intervalMs).toBe(30_000);
    expect(job.timeoutMs).toBe(60_000);
    expect(recoverableQueues()).toEqual([db.outboxQueue]);
  });

  it("recovers each queue and logs only when rows were recovered", async () => {
    db.outboxQueue.recoverStale.mockResolvedValueOnce({ requeued: 0, deadLettered: 0 });
    const quiet = ctx();
    await new LeaseRecoveryJob().run(quiet.context);
    expect(db.outboxQueue.recoverStale).toHaveBeenCalledOnce();
    expect(quiet.log.warn).not.toHaveBeenCalled();

    db.outboxQueue.recoverStale.mockResolvedValueOnce({ requeued: 2, deadLettered: 1 });
    const loud = ctx();
    await new LeaseRecoveryJob().run(loud.context);
    expect(loud.log.warn).toHaveBeenCalledWith(
      { queue: "outbox:all", requeued: 2, deadLettered: 1 },
      "recovered expired leases",
    );
  });

  it("fails the run when a queue's recovery fails", async () => {
    db.outboxQueue.recoverStale.mockRejectedValueOnce(new Error("db down"));
    const { context, log } = ctx();
    await expect(new LeaseRecoveryJob().run(context)).rejects.toThrow("lease recovery failed for 1 queue(s)");
    expect(log.error).toHaveBeenCalled();
  });

  it("does nothing once its signal has aborted", async () => {
    await new LeaseRecoveryJob().run(ctx(AbortSignal.abort()).context);
    expect(db.outboxQueue.recoverStale).not.toHaveBeenCalled();
  });
});
