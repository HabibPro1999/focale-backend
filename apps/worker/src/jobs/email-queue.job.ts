import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Injectable } from "@nestjs/common";
import { createLogger } from "@app/shared";
import {
  processEmailQueue,
  createCertificateAttachmentGenerator,
  type CertificateAttachmentGenerator,
} from "@app/integrations";
import type { Job } from "../job";

const log = createLogger({ name: "worker:email-queue" });

@Injectable()
export class EmailQueueJob implements Job {
  readonly name = "email-queue";
  readonly intervalMs = 15_000;

  private readonly workerId = `email:${hostname()}:${process.pid}:${randomUUID()}`;
  // Wire the certificate PDF generator (integrations) into the queue's
  // CERTIFICATE_SENT attachment callback. Without this, certificate emails
  // throw "Certificate attachment generator not configured".
  private readonly generateCertificateAttachments: CertificateAttachmentGenerator =
    createCertificateAttachmentGenerator();

  async run(): Promise<void> {
    const result = await processEmailQueue(50, {
      workerId: this.workerId,
      generateCertificateAttachments: this.generateCertificateAttachments,
    });
    if (result.processed > 0) {
      log.info({ result }, "Email queue processed");
    }
  }
}
