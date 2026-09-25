import type { AppEvent } from "@app/contracts";
import { enqueueRealtimeOutboxEvent, getDb, getEmailLogRealtimeTargets } from "@app/db";
import { createLogger } from "@app/shared";

const logger = createLogger({ name: "email:status-coalescer" });

/** Window over which email status changes are merged before they are emitted. */
export const EMAIL_STATUS_COALESCE_MS = 250;
/** Email logs resolved per lookup query. */
const TARGET_LOOKUP_CHUNK = 500;

export interface EmailStatusChange {
  emailLogId: string;
  status: string;
}

export interface CoalescedEmailStatusListener {
  /** Install with setEmailStatusChangeListener. Never throws, never blocks. */
  listener: (emailLogId: string, status: string) => void;
  /** Emit everything pending now; resolves once every window so far is emitted. */
  flush(): Promise<void>;
}

/**
 * Coalesce email status changes per 250 ms: the first change after a quiet
 * period opens a window; when it closes, each email log's latest status in it
 * is handed to `emit` as one batch (a batch send moves each log QUEUED →
 * SENDING → SENT within moments; the dashboard only needs where it ended
 * up). Windows are emitted one after another, so a later status is never
 * emitted before an earlier one. A failed window is logged and dropped, like
 * a failed uncoalesced notification. Call flush() before the pool closes.
 */
export function coalesceEmailStatusChanges(
  emit: (changes: EmailStatusChange[]) => Promise<void>,
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
    const changes = [...pending].map(([emailLogId, status]) => ({ emailLogId, status }));
    pending = new Map();
    emitted = emitted.then(async () => {
      try {
        await emit(changes);
      } catch (err) {
        logger.warn({ err, count: changes.length }, "Failed to notify emailLog status changes");
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

/**
 * Emit one window of email status changes as `emailLog.statusChanged`
 * realtime events: one event per (tenant, event, status). A single log keeps
 * the uncoalesced shape (`id`, `status`, `registrationId`); several logs are
 * listed in `ids` (`id` is the first). Logs without a registration or
 * abstract to resolve are skipped, as in emitEmailLogRealtimeEvent.
 */
export async function emitEmailLogRealtimeEvents(changes: EmailStatusChange[]): Promise<void> {
  const groups = new Map<
    string,
    { clientId: string; eventId: string; status: string; ids: string[]; registrationId: string | null }
  >();
  for (let i = 0; i < changes.length; i += TARGET_LOOKUP_CHUNK) {
    const chunk = changes.slice(i, i + TARGET_LOOKUP_CHUNK);
    const targets = await getEmailLogRealtimeTargets(chunk.map((c) => c.emailLogId));
    for (const { emailLogId, status } of chunk) {
      const target = targets.get(emailLogId);
      if (!target) continue;
      const key = JSON.stringify([target.clientId, target.eventId, status]);
      const group = groups.get(key);
      if (group) group.ids.push(emailLogId);
      else groups.set(key, { ...target, status, ids: [emailLogId] });
    }
  }

  for (const group of groups.values()) {
    const [id] = group.ids as [string, ...string[]];
    const event: AppEvent = {
      type: "emailLog.statusChanged",
      clientId: group.clientId,
      eventId: group.eventId,
      payload:
        group.ids.length === 1
          ? { id, status: group.status, registrationId: group.registrationId ?? undefined }
          : { id, status: group.status, ids: group.ids },
      ts: Date.now(),
    };
    try {
      await enqueueRealtimeOutboxEvent(getDb(), event);
    } catch (err) {
      logger.warn({ err, count: group.ids.length }, "Failed to enqueue emailLog status event");
    }
  }
}
