import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { expect, it } from "vitest";
import { JOBS, type Job } from "./job";
import { JobRunner } from "./job-runner";
import { WorkerModule } from "./worker.module";
import { OutboxJob } from "./jobs/outbox.job";
import { EmailQueueJob } from "./jobs/email-queue.job";
import { AbstractBookJob } from "./jobs/abstract-book.job";
import { LeaseRecoveryJob } from "./jobs/lease-recovery.job";
import { RetentionJob } from "./jobs/retention.job";
import { NetworkingDeliveryJob, NetworkingMaintenanceJob, NetworkingEmbeddingJob } from "./jobs/networking.job";

it("boots the worker context with the existing job order and singleton instances", async () => {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  try {
    const jobs = app.get<Job[]>(JOBS);
    expect(jobs.map((job) => job.name)).toEqual([
      "outbox", "email-queue", "abstract-book", "lease-recovery", "retention",
      "networking-delivery", "networking-maintenance", "networking-embeddings",
    ]);
    const classes = [OutboxJob, EmailQueueJob, AbstractBookJob, LeaseRecoveryJob, RetentionJob,
      NetworkingDeliveryJob, NetworkingMaintenanceJob, NetworkingEmbeddingJob];
    for (const [index, JobClass] of classes.entries()) expect(jobs[index]).toBe(app.get<Job>(JobClass));
    expect(app.get(JobRunner)).toBeInstanceOf(JobRunner);
  } finally {
    await app.close();
  }
});
