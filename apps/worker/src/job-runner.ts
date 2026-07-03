import { Inject, Injectable } from "@nestjs/common";
import { createLogger, startPoller, type Poller } from "@app/shared";
import { JOBS, type Job } from "./job";

const log = createLogger({ name: "worker" });

@Injectable()
export class JobRunner {
  private readonly pollers: Poller[] = [];
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(@Inject(JOBS) private readonly jobs: Job[]) {}

  start(): void {
    for (const job of this.jobs) {
      log.info({ job: job.name, intervalMs: job.intervalMs }, "starting job");
      this.tick(job); // run once on boot, then on the interval
      this.pollers.push(
        startPoller({
          name: job.name,
          intervalMs: job.intervalMs,
          work: () => this.tick(job),
        }),
      );
    }
  }

  // Single-flight guard shared by the boot run and the poller ticks: skip when
  // the previous run is still in flight.
  private tick(job: Job): Promise<void> {
    if (this.inFlight.has(job.name)) {
      log.warn({ job: job.name }, "skipping tick — previous run still in flight");
      return Promise.resolve();
    }
    const run = job
      .run()
      .catch((err) => log.error({ job: job.name, err }, "job run failed"))
      .finally(() => this.inFlight.delete(job.name));
    this.inFlight.set(job.name, run);
    return run;
  }

  /** Stop scheduling and await any in-flight runs. */
  async stop(): Promise<void> {
    await Promise.all(this.pollers.map((poller) => poller.stop()));
    this.pollers.length = 0;
    await Promise.allSettled([...this.inFlight.values()]);
  }
}
