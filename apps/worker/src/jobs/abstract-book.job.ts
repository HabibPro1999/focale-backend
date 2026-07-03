import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Injectable } from "@nestjs/common";
import { createLogger } from "@app/shared";
import {
  ABSTRACT_BOOK_LEASE_MS,
  claimAbstractBookJobs,
  completeAbstractBookJob,
  failAbstractBookJob,
  getAbstractBookData,
  recoverStaleAbstractBookJobs,
  stampAbstractBookJobLease,
  type AbstractBookJobRow,
} from "@app/db";
import { getStorageProvider } from "@app/integrations";
import type { Job } from "../job";
import { generateAbstractBookPdf } from "./book/pdf";

const log = createLogger({ name: "worker:abstract-book" });

const HEARTBEAT_MS = 60_000; // extend the lease while a (potentially slow) render runs

@Injectable()
export class AbstractBookJob implements Job {
  readonly name = "abstract-book";
  readonly intervalMs = 30_000;

  private readonly workerId = `abstract-book:${hostname()}:${process.pid}:${randomUUID()}`;

  async run(): Promise<void> {
    await recoverStaleAbstractBookJobs();
    const jobs = await claimAbstractBookJobs(1, this.workerId, ABSTRACT_BOOK_LEASE_MS);
    for (const job of jobs) {
      await this.processOne(job);
    }
  }

  private async processOne(job: AbstractBookJobRow): Promise<void> {
    const heartbeat = this.startHeartbeat(job.id);
    try {
      const data = await getAbstractBookData(job.eventId);
      if (!data) {
        throw new Error("Abstract configuration not found");
      }

      const { buffer, includedCount } = await generateAbstractBookPdf(data);
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
      if (completed === 0) {
        log.warn(
          { jobId: job.id, workerId: this.workerId },
          "Abstract Book completion skipped because lease was lost",
        );
      }
    } catch (err) {
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
      if (failed === 0) {
        log.warn(
          { jobId: job.id, workerId: this.workerId },
          "Abstract Book failure update skipped because lease was lost",
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private startHeartbeat(jobId: string): NodeJS.Timeout {
    const timer = setInterval(() => {
      void stampAbstractBookJobLease({ jobId, workerId: this.workerId }).catch(
        (err) => {
          log.warn(
            { err, jobId, workerId: this.workerId },
            "Failed to extend Abstract Book job lease",
          );
        },
      );
    }, HEARTBEAT_MS);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }
}
