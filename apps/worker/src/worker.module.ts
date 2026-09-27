import { NetworkingDeliveryJob, NetworkingMaintenanceJob, NetworkingEmbeddingJob } from "./jobs/networking.job";
import { Module } from "@nestjs/common";
import { JobRunner } from "./job-runner";
import { JOBS, type Job } from "./job";
import { OutboxJob } from "./jobs/outbox.job";
import { EmailQueueJob } from "./jobs/email-queue.job";
import { AbstractBookJob } from "./jobs/abstract-book.job";

// One ordered registry supplies both the providers and the injected instances.
const JOB_CLASSES = [
  OutboxJob, EmailQueueJob, AbstractBookJob,
  NetworkingDeliveryJob, NetworkingMaintenanceJob, NetworkingEmbeddingJob,
];

@Module({
  providers: [
    JobRunner,
    ...JOB_CLASSES,
    { provide: JOBS, useFactory: (...jobs: Job[]) => jobs, inject: JOB_CLASSES },
  ],
})
export class WorkerModule {}
