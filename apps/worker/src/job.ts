/** A recurring background job. */
export interface Job {
  name: string;
  intervalMs: number;
  run(): Promise<void>;
}

/** Multi-provider DI token collecting all registered jobs. */
export const JOBS = Symbol("JOBS");
