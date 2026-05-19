import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { logger } from "@shared/utils/logger.js";
import { startPoller, type Poller } from "@shared/utils/poller.js";
import { processOutboxEvents } from "./outbox.service.js";

type RealtimeOutboxPump = Poller & { workerId: string };

export function startRealtimeOutboxPump(): RealtimeOutboxPump {
  const workerId = `realtime:${hostname()}:${process.pid}:${randomUUID()}`;
  const poller = startPoller({
    name: "Realtime outbox pump",
    intervalMs: 5_000,
    work: async () => {
      const result = await processOutboxEvents(50, {
        workerId,
        scope: "realtime",
      });
      if (
        result.processed > 0 ||
        result.skipped > 0 ||
        result.failed > 0 ||
        result.leaseLost > 0
      ) {
        logger.info({ result }, "Realtime outbox events processed");
      }
    },
  });
  return { workerId, stop: poller.stop };
}
