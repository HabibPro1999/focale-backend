import { Injectable } from "@nestjs/common";
import { abstractBookQueue, outboxQueue, type LeaseQueue } from "@app/db";
import type { Job, JobContext } from "../job";

/** The lease queues whose expired leases this worker recovers. */
export function recoverableQueues(): LeaseQueue[] {
  return [outboxQueue, abstractBookQueue];
}

/**
 * Stale-lease recovery for every lease queue, in one place instead of at the
 * top of each queue's processing run. A row whose lease expired (its worker
 * died or hung past the lease) goes back to the queue with the attempt
 * charged, or is dead-lettered once its attempts are used up. Rows a live
 * worker holds are never expired: runLeased renews them.
 */
@Injectable()
export class LeaseRecoveryJob implements Job {
  readonly name = "lease-recovery";
  readonly intervalMs = 30_000;
  readonly timeoutMs = 60_000;

  private readonly queues = recoverableQueues();

  async run({ signal, log }: JobContext): Promise<void> {
    const failures: unknown[] = [];
    for (const queue of this.queues) {
      if (signal.aborted) return;
      try {
        const { requeued, deadLettered } = await queue.recoverStale();
        if (requeued > 0 || deadLettered > 0) {
          log.warn({ queue: queue.spec.name, requeued, deadLettered }, "recovered expired leases");
        }
      } catch (err) {
        // One queue's failure does not stop the others.
        log.error({ err, queue: queue.spec.name }, "lease recovery failed");
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `lease recovery failed for ${failures.length} queue(s)`);
    }
  }
}
