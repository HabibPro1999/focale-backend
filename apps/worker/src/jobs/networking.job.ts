import { Injectable } from "@nestjs/common";
import { maintainNetworkingLifecycle } from "@app/db";
import {
  extractStorageKeyFromUrl,
  getStorageProvider,
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
  async run() {
    await maintainNetworkingLifecycle(undefined, async (profiles) => {
      for (const profile of profiles) {
        if (!profile.photoUrl) continue;
        try {
          const key = extractStorageKeyFromUrl(profile.photoUrl);
          if (key) await getStorageProvider().delete(key);
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
    });
  }
}
@Injectable()
export class NetworkingEmbeddingJob implements Job {
  readonly name = "networking-embeddings";
  readonly intervalMs = 15_000;
  async run() {
    const result = await processNetworkingEmbeddings();
    if (result.failed)
      log.warn(
        { failed: result.failed },
        "Networking embeddings queued for retry",
      );
  }
}
