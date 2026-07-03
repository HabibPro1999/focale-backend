import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { makeWorkerId, startPoller, type Poller } from "@app/shared";
import {
  processOutboxEvents,
  REALTIME_EMIT_TYPE,
  type OutboxHandlerRegistry,
  type RealtimeOutboxPayload,
} from "@app/db";
import { CONFIG, type Config } from "../../core/config";
import { logger } from "../../core/logger.service";
import { eventBus } from "./bus";

/**
 * Realtime outbox pump: a 5s poller that claims `scope: "realtime"` outbox rows
 * (type `realtime.emit`) and fans them into the in-process event bus. Runs ONLY
 * in the api process (which holds the bus + SSE connections) and only when
 * realtime is enabled. Started/stopped via Nest lifecycle hooks rather than
 * touching bootstrap. Ported from the legacy `src/core/outbox/realtime-pump.ts`
 * + `src/index.ts` gating.
 */
@Injectable()
export class RealtimePumpService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private poller: Poller | null = null;
  readonly workerId = makeWorkerId("realtime");

  // The only handler this process registers: realtime.emit → bus fan-out.
  private readonly handlers: OutboxHandlerRegistry = {
    [REALTIME_EMIT_TYPE]: (payload) => {
      eventBus.emit(payload as RealtimeOutboxPayload);
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
      intervalMs: 5_000,
      work: async () => {
        const result = await processOutboxEvents(50, {
          workerId: this.workerId,
          scope: "realtime",
          handlers: this.handlers,
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
  }

  async onApplicationShutdown(): Promise<void> {
    await this.poller?.stop();
    this.poller = null;
  }
}
