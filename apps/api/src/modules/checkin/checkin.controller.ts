import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { getEventWithPricing } from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";
import { CheckinService } from "./checkin.service";
import {
  BatchSyncBodyDto,
  CheckInBodyDto,
  CheckInEventParamDto,
  CheckInRegistrationsQueryDto,
} from "./checkin.dto";

/**
 * Check-in routes, mounted at /api/events. Every route requires a valid token
 * (@Auth); per-route ownership is enforced by re-fetching the event and running
 * canAccessClient against its clientId. Route-level 404/403 are plain (code
 * derived by the global filter). POSTs are @HttpCode(200) — legacy Fastify
 * returned 200, not Nest's default 201.
 */
@Auth()
@Controller("api/events")
export class CheckinController {
  constructor(private readonly checkin: CheckinService) {}

  private async authorizeEvent(user: AuthUser, eventId: string): Promise<void> {
    const event = await getEventWithPricing(eventId);
    if (!event) throw new NotFoundException("Event not found");
    if (!canAccessClient(user, event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
  }

  @Post(":eventId/checkin")
  @HttpCode(200)
  async checkIn(
    @CurrentUser() user: AuthUser,
    @Param() params: CheckInEventParamDto,
    @Body() body: CheckInBodyDto,
  ) {
    await this.authorizeEvent(user, params.eventId);
    return this.checkin.checkIn(
      params.eventId,
      body.registrationId,
      body.accessId,
      user.id,
    );
  }

  @Get(":eventId/checkin/registrations")
  async registrations(
    @CurrentUser() user: AuthUser,
    @Param() params: CheckInEventParamDto,
    @Query() query: CheckInRegistrationsQueryDto,
  ) {
    await this.authorizeEvent(user, params.eventId);
    return this.checkin.getCheckInRegistrations(params.eventId, query.accessId);
  }

  @Get(":eventId/checkin/stats")
  async stats(
    @CurrentUser() user: AuthUser,
    @Param() params: CheckInEventParamDto,
  ) {
    await this.authorizeEvent(user, params.eventId);
    return this.checkin.getCheckInStats(params.eventId);
  }

  @Post(":eventId/checkin/sync")
  @HttpCode(200)
  async sync(
    @CurrentUser() user: AuthUser,
    @Param() params: CheckInEventParamDto,
    @Body() body: BatchSyncBodyDto,
  ) {
    await this.authorizeEvent(user, params.eventId);
    return this.checkin.batchSync(params.eventId, body.checkIns, user.id);
  }
}
