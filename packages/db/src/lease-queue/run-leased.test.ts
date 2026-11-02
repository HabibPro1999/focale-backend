import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { JobTimeoutError, WorkerShutdownError } from "@app/shared";

vi.mock("@app/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/shared")>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
  return { ...actual, createLogger: () => log };
});
vi.mock("../client", () => ({ getDb: () => ({ execute: vi.fn() }) }));

import type { LeaseQueue, LeaseQueueSpec } from "./lease-queue";
import { LeaseLostError, runLeased, type RunLeasedOptions } from "./run-leased";

interface Row {
  id: string;
}

/** In-memory queue: tracks owned ids; tests take rows away to simulate recovery. */
function fakeQueue(ids: string[], opts: { leaseMs?: number } = {}) {
  const pending = [...ids];
  const owned = new Set<string>();
  const calls = {
    claim: [] as number[],
    renew: [] as string[][],
    confirm: [] as string[],
    release: [] as string[][],
  };
  const queue: LeaseQueue = {
    spec: { name: "fake", leaseMs: opts.leaseMs ?? 3_000 } as LeaseQueueSpec,
    claim: vi.fn(async (_worker: string, limit: number) => {
      calls.claim.push(limit);
      const batch = pending.splice(0, limit);
      for (const id of batch) owned.add(id);
      return batch;
    }),
    renew: vi.fn(async (_worker: string, renewIds: string[]) => {
      calls.renew.push([...renewIds]);
      return renewIds.filter((id) => owned.has(id));
    }),
    confirm: vi.fn(async (_worker: string, id: string) => {
      calls.confirm.push(id);
      return owned.has(id);
    }),
    complete: vi.fn(async (_worker: string, id: string) => owned.delete(id)),
    fail: vi.fn(async (_worker: string, id: string) => owned.delete(id)),
    release: vi.fn(async (_worker: string, releaseIds: string[]) => {
      calls.release.push([...releaseIds]);
      let n = 0;
      for (const id of releaseIds) if (owned.delete(id)) n++;
      return n;
    }),
    recoverStale: vi.fn(),
    health: vi.fn(),
  };
  /** Recovery took the row: no longer owned. */
  const take = (id: string) => owned.delete(id);
  return { queue, calls, owned, take };
}

function options(
  queue: LeaseQueue,
  overrides: Partial<RunLeasedOptions<Row>> = {},
): RunLeasedOptions<Row> {
  return {
    workerId: "w1",
    limit: 10,
    load: async (ids) => ids.map((id) => ({ id })),
    handle: async (row) => queue.complete("w1", row.id, sql`"status" = 'DONE'`),
    onError: async (row) => queue.fail("w1", row.id, sql`"status" = 'FAILED'`),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runLeased", () => {
  it("confirms ownership right before each handler and completes every row", async () => {
    const { queue, calls } = fakeQueue(["a", "b", "c"]);
    const order: string[] = [];
    const result = await runLeased(
      queue,
      options(queue, {
        handle: async (row) => {
          order.push(`confirmed:${calls.confirm.includes(row.id)}:${row.id}`);
          return queue.complete("w1", row.id, sql``);
        },
      }),
    );
    expect(result).toEqual({ claimed: 3, handled: 3, failed: 0, released: 0, leaseLost: 0 });
    expect(order).toEqual(["confirmed:true:a", "confirmed:true:b", "confirmed:true:c"]);
    expect(queue.release).not.toHaveBeenCalled();
  });

  it("skips a row whose ownership confirm fails (recovered meanwhile)", async () => {
    const { queue, take } = fakeQueue(["a", "b"]);
    const handled: string[] = [];
    const result = await runLeased(
      queue,
      options(queue, {
        load: async (ids) => {
          take("b"); // lease expired and recovery requeued it before its turn
          return ids.map((id) => ({ id }));
        },
        handle: async (row) => {
          handled.push(row.id);
          return queue.complete("w1", row.id, sql``);
        },
      }),
    );
    expect(handled).toEqual(["a"]);
    expect(result).toMatchObject({ handled: 1, leaseLost: 1, released: 0 });
  });

  it("counts claimed rows missing from load as lost", async () => {
    const { queue } = fakeQueue(["a", "b"]);
    const result = await runLeased(queue, options(queue, { load: async () => [{ id: "a" }] }));
    expect(result).toMatchObject({ claimed: 2, handled: 1, leaseLost: 1 });
  });

  it("renews every unfinished row in one heartbeat call while a handler runs", async () => {
    vi.useFakeTimers();
    const { queue, calls } = fakeQueue(["a", "b", "c"]);
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = runLeased(
      queue,
      options(queue, {
        renewEveryMs: 1_000,
        handle: async (row) => {
          if (row.id === "a") await slow;
          return queue.complete("w1", row.id, sql``);
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.renew).toEqual([["a", "b", "c"]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.renew).toHaveLength(2);
    finish();
    await expect(running).resolves.toMatchObject({ handled: 3 });
    // Finished rows are no longer renewed; the heartbeat stops with the batch.
    const beats = calls.renew.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.renew).toHaveLength(beats);
  });

  it("aborts a running handler whose lease the heartbeat finds lost, without recording a failure", async () => {
    vi.useFakeTimers();
    const { queue, take } = fakeQueue(["a"]);
    let reason: unknown;
    const onError = vi.fn(async () => true);
    const running = runLeased(
      queue,
      options(queue, {
        renewEveryMs: 1_000,
        onError,
        handle: (_row, { signal }) =>
          new Promise<boolean>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reason = signal.reason;
              reject(signal.reason);
            });
          }),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    take("a");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(running).resolves.toMatchObject({ handled: 0, failed: 0, leaseLost: 1, released: 0 });
    expect(reason).toBeInstanceOf(LeaseLostError);
    expect(onError).not.toHaveBeenCalled();
  });

  it("counts a terminal write that raced a renewal as handled", async () => {
    vi.useFakeTimers();
    const { queue } = fakeQueue(["a"]);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let afterWrite!: () => void;
    const tail = new Promise<void>((resolve) => {
      afterWrite = resolve;
    });
    // The renewal is issued, the handler's write lands, the renewal answers
    // "not owned" (the row is already done), then the handler returns.
    const renewReplies: Array<(ids: string[]) => void> = [];
    vi.mocked(queue.renew).mockImplementation(
      () => new Promise<string[]>((resolve) => renewReplies.push(resolve)),
    );
    const running = runLeased(
      queue,
      options(queue, {
        renewEveryMs: 1_000,
        handle: async (row) => {
          await gate;
          const written = await queue.complete("w1", row.id, sql``);
          await tail;
          return written;
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renewReplies).toHaveLength(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    renewReplies[0]!([]);
    await vi.advanceTimersByTimeAsync(0);
    afterWrite();
    await expect(running).resolves.toMatchObject({ handled: 1, leaseLost: 0 });
  });

  it("releases the rows not started when the job signal aborts, without an attempt penalty", async () => {
    const { queue, calls, owned } = fakeQueue(["a", "b", "c"]);
    const controller = new AbortController();
    const handled: string[] = [];
    const result = await runLeased(
      queue,
      options(queue, {
        signal: controller.signal,
        handle: async (row) => {
          handled.push(row.id);
          controller.abort(new JobTimeoutError("outbox", 60_000));
          return queue.complete("w1", row.id, sql``);
        },
      }),
    );
    expect(handled).toEqual(["a"]);
    expect(calls.release).toEqual([["b", "c"]]);
    expect(result).toEqual({ claimed: 3, handled: 1, failed: 0, released: 2, leaseLost: 0 });
    expect(owned.size).toBe(0);
  });

  it("releases a row whose handler a shutdown interrupts", async () => {
    const { queue, calls } = fakeQueue(["a", "b"]);
    const controller = new AbortController();
    const onError = vi.fn(async () => true);
    const result = await runLeased(
      queue,
      options(queue, {
        signal: controller.signal,
        onError,
        handle: async () => {
          controller.abort(new WorkerShutdownError());
          throw controller.signal.reason;
        },
      }),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(calls.release).toEqual([["a", "b"]]);
    expect(result).toMatchObject({ handled: 0, failed: 0, released: 2 });
  });

  it("charges a row whose handler a timeout interrupts, and releases the rest", async () => {
    const { queue, calls } = fakeQueue(["a", "b"]);
    const controller = new AbortController();
    const onError = vi.fn(async (row: Row, _error: unknown) => queue.fail("w1", row.id, sql``));
    const result = await runLeased(
      queue,
      options(queue, {
        signal: controller.signal,
        onError,
        handle: async () => {
          controller.abort(new JobTimeoutError("abstract-book", 1_800_000));
          throw controller.signal.reason;
        },
      }),
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![1]).toBeInstanceOf(JobTimeoutError);
    expect(calls.release).toEqual([["b"]]);
    expect(result).toMatchObject({ handled: 0, failed: 1, released: 1 });
  });

  it("claims nothing once the signal is already aborted", async () => {
    const { queue } = fakeQueue(["a"]);
    const result = await runLeased(queue, options(queue, { signal: AbortSignal.abort() }));
    expect(queue.claim).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);
  });

  it("leaves a row leased for recovery when recording its failure fails", async () => {
    const { queue, owned } = fakeQueue(["a"]);
    const result = await runLeased(
      queue,
      options(queue, {
        handle: async () => {
          throw new Error("handler");
        },
        onError: async () => {
          throw new Error("db down");
        },
      }),
    );
    expect(queue.release).not.toHaveBeenCalled();
    expect(owned.has("a")).toBe(true);
    expect(result).toMatchObject({ failed: 0, released: 0 });
  });

  it("finishes the other lanes before releasing when a confirm errors, then rethrows", async () => {
    const { queue, calls } = fakeQueue(["a", "b", "c", "d"]);
    let finishA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      finishA = resolve;
    });
    vi.mocked(queue.confirm).mockImplementation(async (_w, id) => {
      if (id === "b") throw new Error("connection reset");
      return true;
    });
    const events: string[] = [];
    vi.mocked(queue.release).mockImplementation(async (_w, ids) => {
      events.push(`release:${ids.join(",")}`);
      return ids.length;
    });
    const running = runLeased(
      queue,
      options(queue, {
        concurrency: 2,
        handle: async (row) => {
          if (row.id === "a") await gateA;
          events.push(`done:${row.id}`);
          return true;
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([]); // lane 2 stopped at b's confirm error; a still running
    finishA();
    await expect(running).rejects.toThrow("connection reset");
    // a finished first; lane 1 then went on with c and d; only b was released.
    expect(events).toEqual(["done:a", "done:c", "done:d", "release:b"]);
    expect(calls.claim).toEqual([10]);
  });

  it("drains batch after batch until one comes back short", async () => {
    const { queue, calls } = fakeQueue(["a", "b", "c", "d", "e"]);
    const result = await runLeased(queue, options(queue, { limit: 2, drainUntil: Date.now() + 60_000 }));
    expect(calls.claim).toEqual([2, 2, 2]);
    expect(result).toMatchObject({ claimed: 5, handled: 5 });
  });

  it("stops draining at the deadline", async () => {
    const { queue, calls } = fakeQueue(["a", "b", "c", "d"]);
    const result = await runLeased(queue, options(queue, { limit: 2, drainUntil: Date.now() - 1 }));
    expect(calls.claim).toEqual([2]);
    expect(result).toMatchObject({ claimed: 2, handled: 2 });
  });
});
