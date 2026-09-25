import { Injectable } from "@nestjs/common";
import { maintainNetworkingLifecycle } from "@app/db";
import {
  getStorageProvider,
  ownedStorageKey,
  processNetworkingDeliveries,
  processNetworkingEmbeddings,
} from "@app/integrations";
import { createLogger } from "@app/shared";
import type { Job } from "../job";
const log = createLogger({ name: "worker:networking" });
@Injectable()
export class NetworkingDeliveryJob implements Job {
  readonly name = "networking-delivery";
  readonly intervalMs = 2_000;
  // The delivery/maintenance/embedding pipelines do not take an abort signal
  // yet: on timeout the runner logs, and waits for the run to settle.
  readonly timeoutMs = 30_000;
  async run() {
    const result = await processNetworkingDeliveries();
    if (result.failed)
      log.warn(
        { failed: result.failed },
        "Networking notifications queued for retry",
      );
  }
}
@Injectable()
export class NetworkingMaintenanceJob implements Job {
  readonly name = "networking-maintenance";
  readonly intervalMs = 60_000;
  readonly timeoutMs = 5 * 60_000;
  async run() {
    await maintainNetworkingLifecycle(undefined, async (profiles) => {
      // Purge has committed. Cleanup has no durable retry; failures may leave orphaned objects.
      let next = 0;
      const cleanup = async () => {
        while (next < profiles.length) {
          const profile = profiles[next++]!;
          // Form-projected or foreign URLs are never ours to delete.
          const key = ownedStorageKey(profile.photoUrl, `networking/${profile.eventId}/profiles/${profile.id}`);
          if (!key) continue;
          try {
            await getStorageProvider().delete(key);
          } catch (error) {
            const failure = error as {
              code?: string | number;
              name?: string;
              $metadata?: { httpStatusCode?: number };
            };
            if (
              failure?.code === 404 ||
              failure?.code === "404" ||
              failure?.name === "NoSuchKey" ||
              failure?.$metadata?.httpStatusCode === 404
            ) continue;
            log.warn({ err: error, profileId: profile.id }, "Failed to delete purged networking photo");
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, profiles.length) }, cleanup));
    });
  }
}
@Injectable()
export class NetworkingEmbeddingJob implements Job {
  readonly name = "networking-embeddings";
  readonly intervalMs = 15_000;
  readonly timeoutMs = 5 * 60_000;
  async run() {
    const result = await processNetworkingEmbeddings();
    if (result.failed)
      log.warn(
        { failed: result.failed },
        "Networking embeddings queued for retry",
      );
  }
}
