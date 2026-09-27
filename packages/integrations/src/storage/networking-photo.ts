import { getStorageProvider, ownedStorageKey } from "./index";
import type { StorageProvider } from "./storage.provider";

export function isStorageNotFound(error: unknown): boolean {
  const failure = error as { code?: string | number; name?: string; $metadata?: { httpStatusCode?: number } };
  return failure?.code === 404 || failure?.code === "404" || failure?.name === "NoSuchKey" ||
    failure?.$metadata?.httpStatusCode === 404;
}

/** Only participant-owned uploads may be deleted. Callers retain their own error logging. */
export async function deleteOwnedNetworkingPhoto(
  photoUrl: string | null | undefined,
  eventId: string,
  profileId: string,
  storage?: Pick<StorageProvider, "delete">,
): Promise<void> {
  const key = ownedStorageKey(photoUrl, `networking/${eventId}/profiles/${profileId}`);
  if (!key) return;
  try {
    await (storage ?? getStorageProvider()).delete(key);
  } catch (error) {
    if (isStorageNotFound(error)) return;
    throw error;
  }
}
