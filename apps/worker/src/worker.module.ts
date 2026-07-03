import { Module } from "@nestjs/common";
import { JobRunner } from "./job-runner";
import { JOBS } from "./job";
import { OutboxJob } from "./jobs/outbox.job";
import { EmailQueueJob } from "./jobs/email-queue.job";
import { AbstractBookJob } from "./jobs/abstract-book.job";

// JOBS is the registry token JobRunner injects. A factory returns the array of
// job instances; add future jobs to both `inject` and the returned array.
// (This Nest version's provider types omit `multi` and don't honor it at runtime,
//  so we assemble the array explicitly rather than via multi-providers.)
@Module({
  providers: [
    JobRunner,
    OutboxJob,
    EmailQueueJob,
    AbstractBookJob,
    {
      provide: JOBS,
      useFactory: (
        outbox: OutboxJob,
        email: EmailQueueJob,
        book: AbstractBookJob,
      ) => [outbox, email, book],
      inject: [OutboxJob, EmailQueueJob, AbstractBookJob],
    },
  ],
})
export class WorkerModule {}
