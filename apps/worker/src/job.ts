/** A recurring background job. */
export interface Job {
  name: string;
  intervalMs: number;
  run(): Promise<void>;
}

/** DI token for the ordered job array assembled by WorkerModule. */
export const JOBS = Symbol("JOBS");
