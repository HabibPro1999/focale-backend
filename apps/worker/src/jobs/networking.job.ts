import { Injectable } from "@nestjs/common";
import { maintainNetworkingLifecycle } from "@app/db";
import {
  processNetworkingDeliveries,
  processNetworkingEmbeddings,
} from "@app/integrations";
import { createLogger } from "@app/shared";
import type { Job } from "../job";
import { loadConfig } from "../core/config";
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
    // Retention purges and withdrawal erasures run in batches within a time
    // budget and resume on the next run; photos are deleted durably by the
    // outbox storage.delete handler.
    await maintainNetworkingLifecycle(undefined, {
      withdrawalEraseDays: loadConfig().NETWORKING_WITHDRAWAL_ERASE_DAYS,
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
