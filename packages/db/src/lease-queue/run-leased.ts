import { abortedForShutdown, createLogger } from "@app/shared";
import type { LeaseQueue } from "./lease-queue";

const logger = createLogger({ name: "db:lease-queue" });

/** Abort reason of a row handler whose lease was taken over (recovered after expiring). */
export class LeaseLostError extends Error {
  constructor(readonly id: string) {
    super(`Lease on ${id} was lost`);
    this.name = "LeaseLostError";
  }
}

export interface RunLeasedOptions<Row extends { id: string }> {
  workerId: string;
  /** Rows claimed per batch. */
  limit: number;
  /**
   * Job signal (timeout or shutdown). Once aborted no new row starts and the
   * claimed rows not started are released without an attempt penalty. A row
   * whose handler it interrupts is released too on shutdown, but charged
   * (onError) on a timeout, so a row that never fits the budget still ends
   * up dead-lettered.
   */
  signal?: AbortSignal;
  /** Load the claimed rows still owned by this worker, in processing order (claim ids come unordered). */
  load(ids: string[]): Promise<Row[]>;
  /**
   * Process one row and write its terminal state (queue.complete / fail).
   * Resolve false when that write found the row no longer owned.
   * `ctx.signal` aborts on the job signal or when this row's lease is lost.
   */
  handle(row: Row, ctx: { signal: AbortSignal }): Promise<boolean>;
  /**
   * The handler threw: record the failure, which costs the attempt (usually
   * queue.fail with a retry or dead-letter set). Resolve false when the row
   * was no longer owned.
   */
  onError(row: Row, error: unknown): Promise<boolean>;
  /** Rows handled at once (default 1). */
  concurrency?: number;
  /** Lease length (default the queue's). */
  leaseMs?: number;
  /** Heartbeat period (default a third of the lease, at least 1 s). */
  renewEveryMs?: number;
  /**
   * Keep claiming batches until one comes back short, the signal aborts, or
   * this time (epoch ms) passes. Without it, one batch.
   */
  drainUntil?: number;
}

export interface RunLeasedResult {
  claimed: number;
  /** Handlers that finished and wrote their terminal state. */
  handled: number;
  /** Handlers that threw; their failure was recorded (attempt charged). */
  failed: number;
  /** Claimed rows put back unprocessed after an abort, without an attempt charged. */
  released: number;
  /** Rows taken over before or while they were handled (another owner has them). */
  leaseLost: number;
}

function emptyResult(): RunLeasedResult {
  return { claimed: 0, handled: 0, failed: 0, released: 0, leaseLost: 0 };
}

/**
 * Claim → heartbeat → confirm → handle → release. One heartbeat renews the
 * lease of every claimed row not finished yet; a row whose renewal or
 * ownership confirm fails is dropped (its handler's signal aborts). An abort
 * stops starting new rows, and claimed rows not finished go back to the
 * queue without an attempt penalty.
 */
export async function runLeased<Row extends { id: string }>(
  queue: LeaseQueue,
  options: RunLeasedOptions<Row>,
): Promise<RunLeasedResult> {
  const total = emptyResult();
  for (;;) {
    if (options.signal?.aborted) break;
    const batch = await runBatch(queue, options);
    total.claimed += batch.claimed;
    total.handled += batch.handled;
    total.failed += batch.failed;
    total.released += batch.released;
    total.leaseLost += batch.leaseLost;
    if (
      options.drainUntil === undefined ||
      batch.claimed < options.limit ||
      Date.now() >= options.drainUntil
    ) {
      break;
    }
  }
  return total;
}

async function runBatch<Row extends { id: string }>(
  queue: LeaseQueue,
  options: RunLeasedOptions<Row>,
): Promise<RunLeasedResult> {
  const result = emptyResult();
  const { workerId, signal } = options;
  const name = queue.spec.name;
  const leaseMs = options.leaseMs ?? queue.spec.leaseMs;
  const ids = await queue.claim(workerId, options.limit, leaseMs);
  result.claimed = ids.length;
  if (ids.length === 0) return result;

  /** Claimed and not settled: renewed by the heartbeat, released at the end. */
  const unfinished = new Set(ids);
  /** Rows whose handler (or confirm) is running, by id: aborted when their lease is lost. */
  const running = new Map<string, AbortController>();
  const settle = (id: string, outcome: "handled" | "failed" | "lost") => {
    if (!unfinished.delete(id)) return;
    if (outcome === "handled") result.handled++;
    else if (outcome === "failed") result.failed++;
    else {
      result.leaseLost++;
      logger.warn({ queue: name, id, workerId }, "lease lost; another owner has the row");
    }
  };
  // The heartbeat found `id` no longer owned. A running row is only told
  // (its handler's outcome settles it: a terminal write that raced the
  // renewal still counts as handled); an idle row is dropped now.
  const lose = (id: string) => {
    const run = running.get(id);
    if (run) run.abort(new LeaseLostError(id));
    else settle(id, "lost");
  };

  let renewing: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewing || unfinished.size === 0) return;
    const pending = [...unfinished];
    renewing = queue
      .renew(workerId, pending, leaseMs)
      .then((kept) => {
        const stillOwned = new Set(kept);
        for (const id of pending) if (!stillOwned.has(id)) lose(id);
      })
      .catch((err: unknown) => {
        // A failed renewal is not a lost lease: the next beat retries.
        logger.warn({ err, queue: name }, "lease renewal failed");
      })
      .finally(() => {
        renewing = undefined;
      });
  }, options.renewEveryMs ?? Math.max(1_000, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();

  const handleOne = async (row: Row): Promise<void> => {
    const lease = new AbortController();
    running.set(row.id, lease);
    try {
      if (!(await queue.confirm(workerId, row.id, leaseMs))) {
        settle(row.id, "lost");
        return;
      }
      if (lease.signal.aborted) {
        settle(row.id, "lost");
        return;
      }
      const rowSignal = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
      try {
        settle(row.id, (await options.handle(row, { signal: rowSignal })) ? "handled" : "lost");
      } catch (err) {
        if (lease.signal.aborted) {
          settle(row.id, "lost"); // the new owner handles it
        } else if (abortedForShutdown(signal)) {
          // Interrupted by shutdown, not the row's fault: stays unfinished,
          // so it is released below without an attempt penalty.
          logger.warn({ err, queue: name, id: row.id }, "row interrupted by shutdown; releasing it");
        } else {
          try {
            settle(row.id, (await options.onError(row, err)) ? "failed" : "lost");
          } catch (writeError) {
            // Not released (that would refund the attempt): the row stays
            // leased and stale-lease recovery requeues it, attempt charged.
            unfinished.delete(row.id);
            logger.error({ err: writeError, queue: name, id: row.id }, "recording a row failure failed; left for stale-lease recovery");
          }
        }
      }
    } finally {
      running.delete(row.id);
    }
  };

  let laneError: unknown;
  try {
    const rows = await options.load(ids);
    const loaded = new Set(rows.map((row) => row.id));
    for (const id of ids) if (!loaded.has(id)) settle(id, "lost");

    let next = 0;
    const lane = async () => {
      while (next < rows.length && !signal?.aborted) {
        const row = rows[next++]!;
        if (!unfinished.has(row.id)) continue;
        try {
          await handleOne(row);
        } catch (err) {
          // The ownership confirm failed (database error). Stop this lane; the
          // row stays unfinished and is released below, once every other
          // lane has finished its row (nothing is released mid-handler).
          laneError ??= err;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, lane));
  } finally {
    clearInterval(heartbeat);
    await renewing;
    if (unfinished.size > 0) {
      try {
        result.released = await queue.release(workerId, [...unfinished]);
        logger.info({ queue: name, released: result.released, workerId }, "released unprocessed rows without an attempt penalty");
      } catch (err) {
        // Still leased by us: stale-lease recovery requeues them once the lease expires.
        logger.error({ err, queue: name, ids: [...unfinished] }, "releasing unprocessed rows failed");
      }
    }
  }
  if (laneError !== undefined) throw laneError;
  return result;
}
