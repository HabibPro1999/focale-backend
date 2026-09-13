import { Injectable } from "@nestjs/common";
import { maintainNetworkingLifecycle } from "@app/db";
import {
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
    await maintainNetworkingLifecycle();
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
