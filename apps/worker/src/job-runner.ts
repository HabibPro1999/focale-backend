import { Inject, Injectable } from "@nestjs/common";
import { createLogger } from "@app/shared";
import { JOBS, type Job } from "./job";

const log = createLogger({ name: "worker" });

@Injectable()
export class JobRunner {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(@Inject(JOBS) private readonly jobs: Job[]) {}

  start(): void {
    for (const job of this.jobs) {
      log.info({ job: job.name, intervalMs: job.intervalMs }, "starting job");
      this.tick(job); // run once on boot, then on the interval
      this.timers.push(setInterval(() => this.tick(job), job.intervalMs));
    }
  }

  private tick(job: Job): void {
    // Overlap guard: skip if the previous run is still in flight.
    if (this.inFlight.has(job.name)) {
      log.warn({ job: job.name }, "skipping tick — previous run still in flight");
      return;
    }
    const run = job
      .run()
      .catch((err) => log.error({ job: job.name, err }, "job run failed"))
      .finally(() => this.inFlight.delete(job.name));
    this.inFlight.set(job.name, run);
  }

  /** Stop scheduling and await any in-flight runs. */
  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    await Promise.allSettled([...this.inFlight.values()]);
  }
}
