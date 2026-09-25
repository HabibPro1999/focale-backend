import { Inject, Injectable } from "@nestjs/common";
import { createLogger, startPoller, type Poller } from "@app/shared";
import type { WorkerJobHeartbeat } from "@app/db";
import { JOBS, JobTimeoutError, WorkerShutdownError, type Job } from "./job";

const log = createLogger({ name: "worker" });

/** After the shutdown deadline aborts running jobs, how long they get to settle. */
export const JOB_ABORT_SETTLE_MS = 3_000;

type Outcome = NonNullable<WorkerJobHeartbeat["lastOutcome"]>;

interface ActiveRun {
  startedAt: number;
  settled: Promise<void>;
}

interface RunHistory {
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastOutcome?: Outcome;
}

/** Resolves true when `work` settles first, false when `until` (epoch ms) passes first. */
async function settlesBefore(work: Promise<unknown>, until: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, until - Date.now()));
  });
  try {
    return await Promise.race([work.then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Schedules every job on its interval, one run per job at a time. Each run
 * gets an AbortSignal that fires at its timeoutMs or when shutdown reaches its
 * deadline; a run that ignores it keeps its slot until it settles (the next
 * run of that job never overlaps it).
 */
@Injectable()
export class JobRunner {
  private readonly pollers: Poller[] = [];
  /** Aborted by stop(): no new runs start. */
  private readonly scheduling = new AbortController();
  /** Aborted at the shutdown deadline: running jobs are told to stop. */
  private readonly shutdown = new AbortController();
  private readonly active = new Map<string, ActiveRun>();
  private readonly history = new Map<string, RunHistory>();

  constructor(@Inject(JOBS) private readonly jobs: Job[]) {}

  start(): void {
    for (const job of this.jobs) {
      log.info({ job: job.name, intervalMs: job.intervalMs, timeoutMs: job.timeoutMs }, "starting job");
      void this.tick(job); // run once on boot, then on the interval
      this.pollers.push(
        startPoller({
          name: job.name,
          intervalMs: job.intervalMs,
          work: () => this.tick(job),
          signal: this.scheduling.signal,
        }),
      );
    }
  }

  // Single-flight: shared by the boot run and the poller ticks. A new run
  // starts only once the previous one has settled, even past its timeout.
  private tick(job: Job): Promise<void> {
    if (this.scheduling.signal.aborted) return Promise.resolve();
    const current = this.active.get(job.name);
    if (current) {
      log.warn({ job: job.name, runningForMs: Date.now() - current.startedAt }, "skipping tick — previous run still in flight");
      return Promise.resolve();
    }

    const startedAt = Date.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new JobTimeoutError(job.name, job.timeoutMs));
      log.error(
        { job: job.name, timeoutMs: job.timeoutMs },
        "job exceeded its timeout; aborting it (no new run starts until it settles)",
      );
    }, job.timeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([this.shutdown.signal, timeout.signal]);
    const jobLog = log.child({ job: job.name });

    let run: Promise<void>;
    try {
      run = job.run({ signal, deadline: startedAt + job.timeoutMs, log: jobLog });
    } catch (err) {
      run = Promise.reject(err);
    }
    // A run that outlived its abort signal counts as timed out / aborted, even
    // when it then finished normally.
    const abortOutcome = (): Outcome =>
      signal.reason instanceof JobTimeoutError ? "timed-out" : "aborted";
    const settled = run.then(
      (): Outcome => (signal.aborted ? abortOutcome() : "ok"),
      (err: unknown): Outcome => {
        if (signal.aborted) {
          const outcome = abortOutcome();
          jobLog.warn({ err, outcome }, "job run ended after its abort signal");
          return outcome;
        }
        jobLog.error({ err }, "job run failed");
        return "failed";
      },
    ).then((outcome) => {
      clearTimeout(timer);
      this.active.delete(job.name);
      this.history.set(job.name, { lastStartedAt: startedAt, lastFinishedAt: Date.now(), lastOutcome: outcome });
    });
    this.active.set(job.name, { startedAt, settled });
    this.history.set(job.name, { ...this.history.get(job.name), lastStartedAt: startedAt });
    return settled;
  }

  /** Per-job state for the worker heartbeat. */
  snapshot(now = Date.now()): Record<string, WorkerJobHeartbeat> {
    const jobs: Record<string, WorkerJobHeartbeat> = {};
    for (const job of this.jobs) {
      const run = this.active.get(job.name);
      const history = this.history.get(job.name) ?? {};
      const runningForMs = run ? now - run.startedAt : undefined;
      jobs[job.name] = {
        running: Boolean(run),
        ...(runningForMs === undefined ? {} : { runningForMs }),
        timeoutMs: job.timeoutMs,
        overdue: runningForMs !== undefined && runningForMs > 2 * job.timeoutMs,
        ...(history.lastStartedAt ? { lastStartedAt: new Date(history.lastStartedAt).toISOString() } : {}),
        ...(history.lastFinishedAt ? { lastFinishedAt: new Date(history.lastFinishedAt).toISOString() } : {}),
        ...(history.lastOutcome ? { lastOutcome: history.lastOutcome } : {}),
      };
    }
    return jobs;
  }

  /**
   * Stop scheduling and wait for running jobs. With a `deadline` (epoch ms),
   * jobs still running then are aborted through their signal and get
   * `settleMs` to wind down. Returns the jobs that still had not settled.
   */
  async stop(options: { deadline?: number; settleMs?: number } = {}): Promise<{ unfinished: string[] }> {
    this.scheduling.abort();
    const pollers = this.pollers.splice(0);
    const allSettled = Promise.all([
      ...pollers.map((poller) => poller.stop()),
      ...[...this.active.values()].map((run) => run.settled),
    ]);
    if (options.deadline === undefined) {
      await allSettled;
      return { unfinished: [] };
    }
    if (await settlesBefore(allSettled, options.deadline)) return { unfinished: [] };

    log.warn({ jobs: [...this.active.keys()] }, "shutdown deadline reached; aborting running jobs");
    this.shutdown.abort(new WorkerShutdownError());
    if (await settlesBefore(allSettled, Date.now() + (options.settleMs ?? JOB_ABORT_SETTLE_MS))) {
      return { unfinished: [] };
    }
    const unfinished = [...this.active.keys()];
    log.error({ jobs: unfinished }, "jobs ignored the shutdown abort and are still running");
    return { unfinished };
  }
}
