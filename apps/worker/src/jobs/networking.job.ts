import { Injectable } from "@nestjs/common";
import { maintainNetworkingLifecycle } from "@app/db";
import {
  NETWORKING_DELIVERY_INTERVAL_MS,
  networkingDeliveryWorkerOptions,
  processNetworkingDeliveries,
  processNetworkingEmbeddings,
} from "@app/integrations";
import { createLogger } from "@app/shared";
import type { Job, JobContext } from "../job";
import { loadConfig } from "../core/config";
const log = createLogger({ name: "worker:networking" });
/** Margin kept between the last claim and the job timeout: a claimed batch finishes. */
const DELIVERY_CLAIM_MARGIN_MS = 15_000;
@Injectable()
export class NetworkingDeliveryJob implements Job {
  readonly name = "networking-delivery";
  // 1 s between runs (4.2); a run drains the due deliveries on its lanes.
  readonly intervalMs = NETWORKING_DELIVERY_INTERVAL_MS;
  readonly timeoutMs = 30_000;
  async run(ctx: JobContext) {
    const options = networkingDeliveryWorkerOptions();
    const result = await processNetworkingDeliveries({
      signal: ctx.signal,
      until: Math.min(Date.now() + options.runBudgetMs, ctx.deadline - DELIVERY_CLAIM_MARGIN_MS),
    });
    if (result.failed || result.deferred)
      log.warn(
        { failed: result.failed, deferred: result.deferred },
        "Networking notifications queued for retry",
      );
    if (result.uncertain)
      log.warn(
        { uncertain: result.uncertain },
        "Networking emails with an unknown provider outcome were not resent (email logs UNCERTAIN)",
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
