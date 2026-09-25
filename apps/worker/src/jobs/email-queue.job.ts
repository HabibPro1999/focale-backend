import { Injectable } from "@nestjs/common";
import { createLogger, makeWorkerId } from "@app/shared";
import {
  processEmailQueue,
  generateCertificateEmailAttachments,
} from "@app/integrations";
import type { Job, JobContext } from "../job";

const log = createLogger({ name: "worker:email-queue" });

/** Rows claimed per batch; a run keeps claiming batches (see drainUntil). */
export const EMAIL_BATCH_SIZE = 20;
/**
 * Budget kept after the drain window for the batch in flight: two sends per
 * lane (10 lanes), each bounded at 15 s, plus rendering and attachments.
 */
export const EMAIL_DRAIN_MARGIN_MS = 45_000;

@Injectable()
export class EmailQueueJob implements Job {
  readonly name = "email-queue";
  readonly intervalMs = 5_000;
  readonly timeoutMs = 120_000;

  private readonly workerId = makeWorkerId("email");

  async run({ signal, deadline }: JobContext): Promise<void> {
    // Drain: claim batches of 20 until the queue is empty or the drain window
    // (the run's budget minus the margin) ends; the next run starts 5 s later.
    // Wire the certificate PDF generator (integrations) into the queue's
    // CERTIFICATE_SENT attachment callback. Without this, certificate emails
    // throw "Certificate attachment generator not configured".
    const result = await processEmailQueue(EMAIL_BATCH_SIZE, {
      workerId: this.workerId,
      generateCertificateAttachments: generateCertificateEmailAttachments,
      signal,
      drainUntil: deadline - EMAIL_DRAIN_MARGIN_MS,
    });
    if (result.processed > 0) {
      log.info({ result }, "Email queue processed");
    }
  }
}
