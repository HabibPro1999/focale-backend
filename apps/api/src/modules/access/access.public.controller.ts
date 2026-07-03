import { Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { getEventWithPricing, type EventAccessWithPrereqs } from "@app/db";
import { assertEventAcceptsPublicActions } from "../events/events.service";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { AccessService } from "./access.service";
import {
  AccessEventIdParamDto,
  GetGroupedAccessBodyDto,
  PublicAccessItemParamDto,
  ValidateAccessSelectionsBodyDto,
} from "./access.dto";

function hasAccessConditions(item: EventAccessWithPrereqs): boolean {
  if (Array.isArray(item.conditions)) {
    return item.conditions.length > 0;
  }
  return item.conditions !== null;
}

/** Public flat-list visibility: active, within availability window, and — unlike
 *  /grouped — carrying NO conditions at all (condition items are excluded here). */
function isPublicVisibleAccess(
  item: EventAccessWithPrereqs,
  eventId: string,
  now: Date,
): boolean {
  if (item.eventId !== eventId || !item.active) return false;
  if (item.availableFrom && item.availableFrom > now) return false;
  if (item.availableTo && item.availableTo < now) return false;
  if (hasAccessConditions(item)) return false;
  return true;
}

/**
 * Public (unauthenticated) access routes, mounted at /api/public/events.
 * All routes share the legacy accessPublic preset: 20 requests / minute.
 */
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller("api/public/events")
export class AccessPublicController {
  constructor(private readonly access: AccessService) {}

  @Post(":eventId/access/grouped")
  async grouped(
    @Param() params: AccessEventIdParamDto,
    @Body() body: GetGroupedAccessBodyDto,
  ) {
    await this.assertPublicAccessEnabled(params.eventId);
    return this.access.getGroupedAccess(
      params.eventId,
      body.formData,
      body.selectedAccessIds,
    );
  }

  @Post(":eventId/access/validate")
  async validate(
    @Param() params: AccessEventIdParamDto,
    @Body() body: ValidateAccessSelectionsBodyDto,
  ) {
    await this.assertPublicAccessEnabled(params.eventId);
    return this.access.validateAccessSelections(
      params.eventId,
      body.selections,
      body.formData,
    );
  }

  @Get(":eventId/access")
  async listActive(@Param() params: AccessEventIdParamDto) {
    await this.assertPublicAccessEnabled(params.eventId);
    const now = new Date();
    const items = await this.access.listEventAccess(params.eventId, {
      active: true,
    });
    return items.filter((item) =>
      isPublicVisibleAccess(item, params.eventId, now),
    );
  }

  @Get(":eventId/access/:accessId")
  async getOne(@Param() params: PublicAccessItemParamDto) {
    await this.assertPublicAccessEnabled(params.eventId);
    const now = new Date();
    const item = await this.access.getEventAccessById(params.accessId);
    if (!item || !isPublicVisibleAccess(item, params.eventId, now)) {
      throw new NotFoundException("Access item not found");
    }
    return item;
  }

  /** Shared guard: event exists, OPEN + within public window, registrations enabled. */
  private async assertPublicAccessEnabled(eventId: string): Promise<void> {
    const event = await getEventWithPricing(eventId);
    if (!event) throw new NotFoundException("Event not found");
    assertEventAcceptsPublicActions(event);
    await assertClientModuleEnabled(event.clientId, "registrations");
  }
}
