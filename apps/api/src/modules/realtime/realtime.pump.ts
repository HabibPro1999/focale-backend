import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { makeWorkerId, startPoller, type Poller } from "@app/shared";
import {
  isNetworkingNotifyPayload,
  NETWORKING_NOTIFY_TYPE,
  processOutboxEvents,
  REALTIME_EMIT_TYPE,
  type OutboxHandlerRegistry,
  type RealtimeOutboxPayload,
} from "@app/db";
import { CONFIG, type Config } from "../../core/config";
import { logger } from "../../core/logger.service";
import { networkingNotificationHub } from "../../core/networking-notification-hub";
import { eventBus } from "./bus";

/** Poll period: a UI event reaches its streams within about a second. */
export const REALTIME_PUMP_INTERVAL_MS = 1_000;
/** Rows claimed per batch; a full batch claims the next one at once. */
export const REALTIME_PUMP_BATCH = 100;
/** One tick drains at most this long, then the next tick carries on. */
export const REALTIME_PUMP_DRAIN_MS = 5_000;

/**
 * Realtime outbox pump: every second it claims `scope: "realtime"` outbox
 * rows (`REALTIME_OUTBOX_TYPES`) in batches of 100, draining until a batch
 * comes back short (at most 5 s per tick): `realtime.emit` rows fan into the
 * in-process event bus, `networking.notify` rows into the participant hub. Runs ONLY in the api process (which holds the bus + SSE connections)
 * and only when realtime is enabled. One api instance only: the bus is
 * process-local (see README "Realtime"). Started/stopped via Nest lifecycle
 * hooks rather than touching bootstrap.
 */
@Injectable()
export class RealtimePumpService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private poller: Poller | null = null;
  private readonly stopping = new AbortController();
  readonly workerId = makeWorkerId("realtime");

  // One handler per realtime-scoped type (every type the scope claims).
  private readonly handlers: OutboxHandlerRegistry = {
    [REALTIME_EMIT_TYPE]: (payload) => {
      eventBus.emit(payload as RealtimeOutboxPayload);
      return "processed";
    },
    [NETWORKING_NOTIFY_TYPE]: (payload) => {
      if (!isNetworkingNotifyPayload(payload)) return "skipped";
      networkingNotificationHub.publish(payload);
      return "processed";
    },
  };

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  onApplicationBootstrap(): void {
    if (this.config.realtime.disabled) {
      logger.info("Realtime disabled; outbox pump not started");
      return;
    }
    this.poller = startPoller({
      name: "Realtime outbox pump",
      intervalMs: REALTIME_PUMP_INTERVAL_MS,
      signal: this.stopping.signal,
      work: async () => {
        const result = await processOutboxEvents(REALTIME_PUMP_BATCH, {
          workerId: this.workerId,
          scope: "realtime",
          handlers: this.handlers,
          signal: this.stopping.signal,
          drainUntil: Date.now() + REALTIME_PUMP_DRAIN_MS,
        });
        if (result.failed > 0 || result.leaseLost > 0) {
          logger.warn({ result }, "Realtime outbox events failed or lost their lease");
        } else if (result.processed > 0 || result.skipped > 0) {
          logger.debug({ result }, "Realtime outbox events processed");
        }
      },
    });
  }

  // Before Fastify closes (not onApplicationShutdown, which Nest runs only
  // after the server has closed): no new events are fanned out to streams
  // that are being drained. Aborting releases the rows of a batch in flight
  // without an attempt charged.
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping.abort();
    await this.poller?.stop();
    this.poller = null;
  }
}
