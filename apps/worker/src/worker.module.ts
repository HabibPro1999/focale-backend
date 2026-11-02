import { NetworkingDeliveryJob, NetworkingMaintenanceJob, NetworkingEmbeddingJob } from "./jobs/networking.job";
import { Module } from "@nestjs/common";
import { JobRunner } from "./job-runner";
import { JOBS, type Job } from "./job";
import { OutboxJob } from "./jobs/outbox.job";
import { EmailQueueJob } from "./jobs/email-queue.job";
import { AbstractBookJob } from "./jobs/abstract-book.job";
import { LeaseRecoveryJob } from "./jobs/lease-recovery.job";
import { RetentionJob } from "./jobs/retention.job";

// One ordered registry supplies providers and the injected job instances.
const JOB_CLASSES = [
  OutboxJob,
  EmailQueueJob,
  AbstractBookJob,
  LeaseRecoveryJob,
  RetentionJob,
  NetworkingDeliveryJob,
  NetworkingMaintenanceJob,
  NetworkingEmbeddingJob,
];

@Module({
  providers: [
    JobRunner,
    ...JOB_CLASSES,
    { provide: JOBS, useFactory: (...jobs: Job[]) => jobs, inject: JOB_CLASSES },
  ],
})
export class WorkerModule {}
