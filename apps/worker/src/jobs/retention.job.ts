import { Injectable } from "@nestjs/common";
import { runOutboxRetention } from "@app/db";
import type { Job, JobContext } from "../job";

/**
 * Hourly outbox retention (and once at boot), in 1,000-row batches: deletes
 * `realtime.emit` rows older than 24 h and finished unkeyed background rows
 * older than 30 d, and compacts finished keyed rows older than 30 d (payload
 * `{}`; the row stays so its dedupe_key keeps rejecting duplicates). A run cut
 * short by its budget or shutdown resumes on the next one.
 */
@Injectable()
export class RetentionJob implements Job {
  readonly name = "retention";
  readonly intervalMs = 60 * 60_000;
  readonly timeoutMs = 5 * 60_000;

  async run({ signal, log }: JobContext): Promise<void> {
    const result = await runOutboxRetention({ signal });
    if (result.realtimeDeleted > 0 || result.backgroundDeleted > 0 || result.compacted > 0) {
      log.info({ outbox: result }, "outbox retention");
    }
  }
}
