import type { ProcessOutboxResult } from "./outbox";

/** Log work and lease losses, while leaving idle polls quiet. */
export function hasOutboxActivity(result: ProcessOutboxResult): boolean {
  return result.processed > 0 || result.skipped > 0 || result.failed > 0 || result.leaseLost > 0;
}
