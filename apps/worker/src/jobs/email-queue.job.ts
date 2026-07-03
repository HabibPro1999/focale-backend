import { Injectable } from "@nestjs/common";
import { createLogger, makeWorkerId } from "@app/shared";
import {
  processEmailQueue,
  generateCertificateEmailAttachments,
} from "@app/integrations";
import type { Job } from "../job";

const log = createLogger({ name: "worker:email-queue" });

@Injectable()
export class EmailQueueJob implements Job {
  readonly name = "email-queue";
  readonly intervalMs = 15_000;

  private readonly workerId = makeWorkerId("email");

  async run(): Promise<void> {
    // Wire the certificate PDF generator (integrations) into the queue's
    // CERTIFICATE_SENT attachment callback. Without this, certificate emails
    // throw "Certificate attachment generator not configured".
    const result = await processEmailQueue(50, {
      workerId: this.workerId,
      generateCertificateAttachments: generateCertificateEmailAttachments,
    });
    if (result.processed > 0) {
      log.info({ result }, "Email queue processed");
    }
  }
}
