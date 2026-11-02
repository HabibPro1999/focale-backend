import type { OutboxHandlerResult, StorageDeleteOutboxPayload } from "@app/db";
import { logger } from "../logger";
import { getStorageProvider, ownedStorageKey } from "./index";
import { StorageObjectNotFoundError, type StorageProvider } from "./storage.provider";

/**
 * Upload roots a storage.delete row may target. The handler is the last
 * guard: a row can only delete a key strictly under its owner prefix, and
 * that prefix must sit under one of these roots.
 */
export const STORAGE_DELETE_ROOTS = ["networking/"] as const;

/** Firebase 404, R2 NoSuchKey, or our own not-found error: the object is already gone. */
export function isStorageObjectMissing(error: unknown): boolean {
  if (error instanceof StorageObjectNotFoundError) return true;
  const failure = error as { code?: string | number; name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return failure?.code === 404 || failure?.code === "404" || failure?.name === "NoSuchKey" ||
    failure?.$metadata?.httpStatusCode === 404;
}

/**
 * Outbox handler for `storage.delete`. Deleted or already missing → processed;
 * a URL that is not ours (form-supplied, foreign, traversal) → skipped, never
 * deleted; any other provider failure throws so the outbox retries with backoff.
 */
export async function handleStorageDeleteOutbox(
  payload: unknown,
  provider: () => StorageProvider = getStorageProvider,
): Promise<OutboxHandlerResult> {
  const { url, ownerPrefix, reason } = (payload ?? {}) as Partial<StorageDeleteOutboxPayload>;
  const prefix = typeof ownerPrefix === "string" ? ownerPrefix : "";
  const key = STORAGE_DELETE_ROOTS.some((root) => prefix.startsWith(root))
    ? ownedStorageKey(typeof url === "string" ? url : null, prefix)
    : null;
  if (!key) {
    logger.info({ ownerPrefix: prefix, reason }, "storage.delete skipped: not an owned upload");
    return "skipped";
  }
  try {
    await provider().delete(key);
  } catch (error) {
    if (!isStorageObjectMissing(error)) throw error;
  }
  return "processed";
}
