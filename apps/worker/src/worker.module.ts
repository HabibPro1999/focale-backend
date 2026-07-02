import { Module } from "@nestjs/common";
import { JobRunner } from "./job-runner";
import { JOBS } from "./job";
import { HeartbeatJob } from "./jobs/heartbeat.job";

// JOBS is the registry token JobRunner injects. A factory returns the array of
// job instances; add future jobs to both `inject` and the returned array.
// (This Nest version's provider types omit `multi` and don't honor it at runtime,
//  so we assemble the array explicitly rather than via multi-providers.)
@Module({
  providers: [
    JobRunner,
    HeartbeatJob,
    {
      provide: JOBS,
      useFactory: (heartbeat: HeartbeatJob) => [heartbeat],
      inject: [HeartbeatJob],
    },
  ],
})
export class WorkerModule {}
