import { Injectable } from "@nestjs/common";
import { createLogger, makeWorkerId } from "@app/shared";
import {
  abstractBookQueue,
  completeAbstractBookJob,
  failAbstractBookJob,
  getAbstractBookData,
  loadClaimedAbstractBookJobs,
  runLeased,
  type AbstractBookJobRow,
} from "@app/db";
import { getStorageProvider } from "@app/integrations";
import type { Job, JobContext } from "../job";
import { generateAbstractBookPdf } from "./book/pdf";

const log = createLogger({ name: "worker:abstract-book" });

/**
 * Renders one Abstract Book job per run through the lease queue. The lease
 * (5 min) is renewed by runLeased's heartbeat while the render runs; if a
 * renewal finds the job taken over (its lease expired and was recovered), the
 * render is aborted at its next yield and nothing is uploaded or written. On
 * shutdown the job goes back to the queue without an attempt charged; a
 * timeout or render error costs the attempt (retry with backoff, then FAILED).
 */
@Injectable()
export class AbstractBookJob implements Job {
  readonly name = "abstract-book";
  readonly intervalMs = 30_000;
  readonly timeoutMs = 30 * 60_000;

  private readonly workerId = makeWorkerId("abstract-book");

  async run({ signal }: JobContext): Promise<void> {
    const result = await runLeased<AbstractBookJobRow>(abstractBookQueue, {
      workerId: this.workerId,
      limit: 1,
      signal,
      load: (ids) => loadClaimedAbstractBookJobs(ids, this.workerId),
      handle: (job, row) => this.render(job, row.signal),
      onError: (job, err) => this.fail(job, err),
    });
    if (result.leaseLost > 0 || result.released > 0) {
      log.warn({ result, workerId: this.workerId }, "Abstract Book run ended without its job");
    }
  }

  /** `signal` aborts on the job's timeout or shutdown, or when the lease is lost. */
  private async render(job: AbstractBookJobRow, signal: AbortSignal): Promise<boolean> {
    const data = await getAbstractBookData(job.eventId);
    if (!data) {
      throw new Error("Abstract configuration not found");
    }
    signal.throwIfAborted();

    const { buffer, includedCount } = await generateAbstractBookPdf(data, { signal });
    signal.throwIfAborted();
    const key = `${job.eventId}/abstracts/book/${job.id}.pdf`;
    const storageKey = await getStorageProvider().uploadPrivate(
      buffer,
      key,
      "application/pdf",
      {
        contentDisposition: `attachment; filename="abstract-book-${job.eventId}.pdf"`,
      },
    );

    const completed = await completeAbstractBookJob({
      jobId: job.id,
      workerId: this.workerId,
      storageKey,
      includedCount,
    });
    if (!completed) {
      log.warn(
        { jobId: job.id, workerId: this.workerId },
        "Abstract Book completion skipped because lease was lost",
      );
    }
    return completed;
  }

  private async fail(job: AbstractBookJobRow, err: unknown): Promise<boolean> {
    log.error(
      { err, jobId: job.id, eventId: job.eventId },
      "Abstract Book generation failed",
    );
    const failed = await failAbstractBookJob({
      jobId: job.id,
      workerId: this.workerId,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      message: err instanceof Error ? err.message : "Unknown error",
    });
    if (!failed) {
      log.warn(
        { jobId: job.id, workerId: this.workerId },
        "Abstract Book failure update skipped because lease was lost",
      );
    }
    return failed;
  }
}
