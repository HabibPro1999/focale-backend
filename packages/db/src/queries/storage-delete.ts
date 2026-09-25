import type { DbExecutor } from "../client";
import { enqueueOutboxEvent } from "../outbox/outbox";

/**
 * Durable storage deletion: an outbox row written in the same transaction as
 * the data change that orphans the object. The worker's `storage.delete`
 * handler (@app/integrations) deletes the object with retries, counts a
 * missing object as done, and only ever deletes a key that lies under
 * `ownerPrefix`, so a form-supplied or foreign URL is skipped, never deleted.
 */
export const STORAGE_DELETE_OUTBOX_TYPE = "storage.delete";
/** A slow or unavailable provider is retried with the outbox backoff before dead-lettering. */
export const STORAGE_DELETE_MAX_ATTEMPTS = 10;

export interface StorageDeleteOutboxPayload {
  /** The stored URL (or bare key) as the owning row held it. */
  url: string;
  /** The key must lie strictly under this prefix to be deleted. */
  ownerPrefix: string;
  /** Why the object is being deleted (logs and outbox inspection only). */
  reason: string;
}

/** The only upload prefix a networking profile owns. */
export function networkingProfilePhotoPrefix(eventId: string, profileId: string) {
  return `networking/${eventId}/profiles/${profileId}`;
}

/** Rides the caller's transaction: the deletes are queued if and only if it commits. */
export async function enqueueStorageDeletes(
  exec: DbExecutor,
  items: Array<StorageDeleteOutboxPayload & { eventId?: string }>,
): Promise<number> {
  let queued = 0;
  for (const { eventId, ...payload } of items) {
    if (!payload.url) continue;
    await enqueueOutboxEvent(exec, {
      type: STORAGE_DELETE_OUTBOX_TYPE,
      payload,
      aggregateType: "storage",
      aggregateId: payload.ownerPrefix,
      eventId,
      maxAttempts: STORAGE_DELETE_MAX_ATTEMPTS,
    });
    queued++;
  }
  return queued;
}

/** The photo of a networking profile that is being withdrawn or purged. */
export function enqueueNetworkingPhotoDeletes(
  exec: DbExecutor,
  profiles: Array<{ id: string; eventId: string; photoUrl: string | null | undefined }>,
  reason: string,
) {
  return enqueueStorageDeletes(
    exec,
    profiles.flatMap((profile) => profile.photoUrl
      ? [{
          url: profile.photoUrl,
          ownerPrefix: networkingProfilePhotoPrefix(profile.eventId, profile.id),
          reason,
          eventId: profile.eventId,
        }]
      : []),
  );
}
