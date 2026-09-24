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

  /**
   * Stop scheduling and wait for in-flight runs, until `deadline` (epoch ms)
   * when given. Returns the jobs still running at the deadline; they cannot be
   * aborted yet (the job contract gains an abort signal in plan item 3.3).
   */
  async stop(options: { deadline?: number } = {}): Promise<{ unfinished: string[] }> {
    const pollers = this.pollers.splice(0);
    // poller.stop() flips its stop flag synchronously, so no new tick starts.
    const settled = Promise.all([
      ...pollers.map((poller) => poller.stop()),
      Promise.allSettled([...this.inFlight.values()]),
    ]).then(() => "settled" as const);
    if (options.deadline === undefined) {
      await settled;
      return { unfinished: [] };
    }
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), Math.max(0, options.deadline! - Date.now()));
    });
    try {
      const outcome = await Promise.race([settled, expired]);
      if (outcome === "settled") return { unfinished: [] };
      const unfinished = [...this.inFlight.keys()];
      log.warn({ jobs: unfinished }, "shutdown deadline reached with jobs still running");
      return { unfinished };
    } finally {
      clearTimeout(timer);
    }
  }
}
