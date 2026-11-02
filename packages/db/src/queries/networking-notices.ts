import { createLogger } from "@app/shared";
import type { DbExecutor } from "../client";
import { enqueueOutboxEvent, realtimeOutboxDisabled } from "../outbox/outbox";
import { NETWORKING_NOTIFY_TYPE } from "../outbox/types";

const logger = createLogger({ name: "db:networking-notices" });

/**
 * "Participant `profileId` of event `eventId` has new notifications." A signal
 * only: it carries IDs, never notification content. The api's participant hub
 * wakes that participant's streams, which then read their own rows.
 */
export interface NetworkingNotice {
  eventId: string;
  profileId: string;
}

/** A `networking.notify` outbox payload: IDs only. */
export interface NetworkingNotifyPayload extends NetworkingNotice {
  notificationId: string;
}

export function isNetworkingNotifyPayload(value: unknown): value is NetworkingNotifyPayload {
  if (!value || typeof value !== "object") return false;
  const { eventId, profileId, notificationId } = value as Record<string, unknown>;
  return [eventId, profileId, notificationId].every((id) => typeof id === "string" && id.length > 0);
}

export type NetworkingNoticePublisher = (notices: readonly NetworkingNotice[]) => void;

let publisher: NetworkingNoticePublisher | null = null;
// Notices of a networking transaction attempt, keyed by its transaction
// executor; published only once that attempt has committed.
const pending = new WeakMap<object, NetworkingNotice[]>();

/**
 * The api registers its in-process participant hub here at startup. Without a
 * publisher (worker, scripts, tests) every notice goes through the outbox.
 */
export function setNetworkingNoticePublisher(next: NetworkingNoticePublisher | null): void {
  publisher = next;
}

/**
 * Bind a fresh notice buffer to one networking transaction attempt's executor;
 * the caller publishes it once that attempt has committed (a retried attempt
 * gets a new buffer, so a rolled-back attempt's notices are dropped).
 */
export function bufferNetworkingNotices(tx: object): NetworkingNotice[] {
  const notices: NetworkingNotice[] = [];
  pending.set(tx, notices);
  return notices;
}

/**
 * After commit: hand the notices, one per participant, to the in-process
 * publisher. Never throws, since the write it follows has already committed.
 */
export function publishNetworkingNotices(notices: readonly NetworkingNotice[]): void {
  if (!publisher || notices.length === 0) return;
  const unique = new Map(notices.map((notice) => [`${notice.eventId}\n${notice.profileId}`, notice]));
  try {
    publisher([...unique.values()]);
  } catch (err) {
    logger.error({ err }, "Networking notice publisher threw");
  }
}

/**
 * Tell the participant's streams about a notification written on `db`.
 * Inside a networking transaction of a process with a publisher (the api),
 * the notice is buffered and published in-process after commit. Anywhere else
 * (the worker, db-level producers on other transactions) it becomes a
 * `networking.notify` outbox row in the same transaction, which the api's
 * realtime pump relays to the hub. Under REALTIME_DISABLED no row is written
 * (no pump drains them); those streams catch up at their periodic resync.
 */
export async function signalNetworkingNotification(
  db: DbExecutor,
  payload: NetworkingNotifyPayload,
): Promise<void> {
  const buffer = publisher ? pending.get(db) : undefined;
  if (buffer) {
    buffer.push({ eventId: payload.eventId, profileId: payload.profileId });
    return;
  }
  if (realtimeOutboxDisabled()) return;
  await enqueueOutboxEvent(db, {
    type: NETWORKING_NOTIFY_TYPE,
    payload: {
      eventId: payload.eventId,
      profileId: payload.profileId,
      notificationId: payload.notificationId,
    } satisfies NetworkingNotifyPayload,
    aggregateType: "networking.notification",
    aggregateId: payload.notificationId,
    eventId: payload.eventId,
    maxAttempts: 10,
  });
}
