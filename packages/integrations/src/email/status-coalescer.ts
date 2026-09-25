import { createLogger } from "@app/shared";
import type { EmailStatusChangeListener } from "./queue";

const logger = createLogger({ name: "email:status-coalescer" });

/** Window over which email status changes are merged before they are emitted. */
export const EMAIL_STATUS_COALESCE_MS = 250;

export interface CoalescedEmailStatusListener {
  /** Install with setEmailStatusChangeListener. Never throws, never blocks. */
  listener: EmailStatusChangeListener;
  /** Emit everything pending now; resolves once every emit so far has run. */
  flush(): Promise<void>;
}

/**
 * Coalesce email status changes per 250 ms: the first change after a quiet
 * period opens a window, and when it closes each email log's latest status is
 * emitted once (a batch send moves each log QUEUED → SENDING → SENT within
 * moments; the dashboard only needs where it ended up). Windows are emitted
 * one after another, so a later status is never emitted before an earlier
 * one. A failed emit is logged and skipped, like the uncoalesced listener.
 * Call flush() before the database closes on shutdown.
 */
export function coalesceEmailStatusChanges(
  emit: EmailStatusChangeListener,
  windowMs = EMAIL_STATUS_COALESCE_MS,
): CoalescedEmailStatusListener {
  let pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let emitted: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.size === 0) return emitted;
    const batch = pending;
    pending = new Map();
    emitted = emitted.then(async () => {
      for (const [emailLogId, status] of batch) {
        try {
          await emit(emailLogId, status);
        } catch (err) {
          logger.warn({ err, emailLogId }, "Failed to notify emailLog status change");
        }
      }
    });
    return emitted;
  };

  return {
    listener: (emailLogId, status) => {
      pending.set(emailLogId, status);
      if (!timer) {
        timer = setTimeout(() => void flush(), windowMs);
        timer.unref?.();
      }
    },
    flush,
  };
}
