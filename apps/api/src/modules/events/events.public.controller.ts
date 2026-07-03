import { Controller, Get, Param } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { EventsService } from "./events.service";
import { EventIdParamDto } from "./events.dto";

/** Public (unauthenticated) event routes — mounted at /api/public/events. */
@Controller("api/public/events")
export class EventsPublicController {
  constructor(private readonly events: EventsService) {}

  // Legacy per-route preset publicRateLimits.accessPublic = 20 / minute.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(":id/payment-config")
  paymentConfig(@Param() params: EventIdParamDto) {
    return this.events.getPaymentConfig(params.id);
  }
}
