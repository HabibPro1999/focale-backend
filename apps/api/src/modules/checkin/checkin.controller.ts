import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { EventScoped } from "../tenancy";
import { type AuthUser } from "../../core/auth/user-cache";
import { CheckinService } from "./checkin.service";
import {
  BatchSyncBodyDto,
  CheckInBodyDto,
  CheckInEventParamDto,
  CheckInRegistrationsQueryDto,
} from "./checkin.dto";

/**
 * Check-in routes, mounted at /api/events. Every route requires a valid token
 * (@Auth); `@EventScoped()` checks the event exists (404) and belongs to the
 * caller's client (403). POSTs are @HttpCode(200) — legacy Fastify returned
 * 200, not Nest's default 201.
 */
@Auth()
@Controller("api/events")
export class CheckinController {
  constructor(private readonly checkin: CheckinService) {}

  @Post(":eventId/checkin")
  @EventScoped()
  @HttpCode(200)
  async checkIn(
    @CurrentUser() user: AuthUser,
    @Param() params: CheckInEventParamDto,
    @Body() body: CheckInBodyDto,
  ) {
    return this.checkin.checkIn(
      params.eventId,
      body.registrationId,
      body.accessId,
      user.id,
    );
  }

  @Get(":eventId/checkin/registrations")
  @EventScoped()
  async registrations(
    @Param() params: CheckInEventParamDto,
    @Query() query: CheckInRegistrationsQueryDto,
  ) {
    return this.checkin.getCheckInRegistrations(params.eventId, query.accessId);
  }

  @Get(":eventId/checkin/stats")
  @EventScoped()
  async stats(@Param() params: CheckInEventParamDto) {
    return this.checkin.getCheckInStats(params.eventId);
  }

  @Post(":eventId/checkin/sync")
  @EventScoped()
  @HttpCode(200)
  async sync(
    @CurrentUser() user: AuthUser,
    @Param() params: CheckInEventParamDto,
    @Body() body: BatchSyncBodyDto,
  ) {
    return this.checkin.batchSync(params.eventId, body.checkIns, user.id);
  }
}
