import { Injectable } from "@nestjs/common";
import { runEmailSnapshotRetention, runOutboxRetention } from "@app/db";
import type { Job, JobContext } from "../job";

/**
 * Hourly retention (and once at boot), in 1,000-row batches. A run cut short
 * by its budget or shutdown resumes on the next one.
 * - Outbox: deletes `realtime.emit` rows older than 24 h and finished unkeyed
 *   background rows older than 30 d, and compacts finished keyed rows older
 *   than 30 d (payload `{}`; the row stays so its dedupe_key keeps rejecting
 *   duplicates).
 * - Email logs (3.6b): clears the context snapshot of finished emails queued
 *   more than 90 d ago (certificate emails keep their certificate template
 *   ids; networking rows are left to networking retention). The process's
 *   first complete pass covers the whole table; later ones only the last 7 d
 *   past the limit.
 */
@Injectable()
export class RetentionJob implements Job {
  readonly name = "retention";
  readonly intervalMs = 60 * 60_000;
  readonly timeoutMs = 5 * 60_000;

  /** Set once a full email snapshot pass completed in this process. */
  private emailSnapshotsSwept = false;

  async run({ signal, log }: JobContext): Promise<void> {
    const result = await runOutboxRetention({ signal });
    if (result.realtimeDeleted > 0 || result.backgroundDeleted > 0 || result.compacted > 0) {
      log.info({ outbox: result }, "outbox retention");
    }

    const fullPass = !this.emailSnapshotsSwept;
    const snapshots = await runEmailSnapshotRetention({ signal, fullPass });
    if (fullPass && snapshots.complete) this.emailSnapshotsSwept = true;
    if (snapshots.cleared > 0) {
      log.info({ emailSnapshots: { ...snapshots, fullPass } }, "email snapshot retention");
    }
  }
}
