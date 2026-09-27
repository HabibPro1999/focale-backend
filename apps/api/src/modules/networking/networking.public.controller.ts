import { NetworkingAuthService } from "./networking.auth.service";
import { NetworkingProfileService } from "./networking.profile.service";
import { NetworkingNotificationsService } from "./networking.notifications.service";
import { openNotificationStream } from "./networking.stream";
import {
  Body,
  Controller,
  Optional,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import { NetworkingBusyInterceptor } from "./networking.busy";
import { NetworkingUploadsService, type NetworkingMultipartRequest } from "./networking.uploads.service";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { ShutdownCoordinator } from "../../core/shutdown";
import { NetworkingService } from "./networking.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingExportsService } from "./networking.exports.service";

import * as dto from "./networking.dto";

@UseInterceptors(NetworkingBusyInterceptor)
@Controller("api/networking/:slug")
export class NetworkingPublicController {
  constructor(
    private readonly uploads: NetworkingUploadsService,
    private readonly service: NetworkingService,
    private readonly social: NetworkingSocialService,
    private readonly meetings: NetworkingMeetingsService,
    private readonly exports: NetworkingExportsService,
    private readonly auth: NetworkingAuthService,
    private readonly profileService: NetworkingProfileService,
    private readonly notificationsService: NetworkingNotificationsService,
    // Global (CoreModule); optional only so unit tests can construct the controller directly.
    @Optional() private readonly lifecycle?: ShutdownCoordinator,
  ) {}
  private context(slug: string, request: FastifyRequest, options: { allowConsentPending?: boolean } = {}) {
    return this.service.participant(slug, request.headers.authorization, { ...options, ip: request.ip });
  }
  // Public reads are bounded only by the shared venue bucket.
  @SkipThrottle({ default: true })
  @Get("config") config(@Param("slug") slug: string) {
    return this.service.publicConfig(slug);
  }
  @SkipThrottle({ default: true })
  @Get("registration") registration(@Param("slug") slug: string) {
    return this.service.registrationInfo(slug);
  }
  @Post("auth/request")
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  requestCode(
    @Param("slug") slug: string,
    @Body() body: dto.NetworkingOtpRequestDto,
  ) {
    return this.auth.requestCode(slug, body.email);
  }
  @Post("auth/verify")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifyCode(
    @Param("slug") slug: string,
    @Body() body: dto.NetworkingOtpVerifyDto,
  ) {
    return this.auth.verifyCode(slug, body.challengeId, body.code);
  }
  @Post("auth/logout") logout(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    return this.auth.logout(slug, req.headers.authorization);
  }
  @Get("me") async me(@Param("slug") slug: string, @Req() req: FastifyRequest) {
    return (await this.context(slug, req, { allowConsentPending: true })).profile;
  }
  @Get("me/analytics") async personalAnalytics(@Param("slug") slug: string, @Req() req: FastifyRequest) {
    return this.profileService.personalAnalytics(await this.context(slug, req));
  }
  @Patch("me") async updateMe(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingProfileDto,
  ) {
    return this.profileService.updateMe(await this.context(slug, req, { allowConsentPending: true }), { ...body });
  }
  @Post("me/photo")
  async uploadPhoto(
    @Param("slug") slug: string,
    @Req() request: NetworkingMultipartRequest,
  ) {
    const ctx = await this.context(slug, request);
    // updateMe removes the replaced photo after its transaction commits.
    return this.uploads.image(
      request,
      `networking/${ctx.event.id}/profiles/${ctx.profile.id}`,
      (url) => this.profileService.updateMe(ctx, { photoUrl: url }),
    );
  }
  @Get("interests/incoming")
  async incomingInterests(
    @Param("slug") slug: string,
    @Req() request: FastifyRequest,
  ) {
    return this.social.incoming(await this.context(slug, request));
  }
  @Get("facets")
  async facets(@Param("slug") slug: string, @Req() request: FastifyRequest) {
    return this.service.facets(await this.context(slug, request));
  }
  @Get("profiles") async profiles(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingListDto,
  ) {
    return this.service.discover(await this.context(slug, req), query);
  }
  @Get("profiles/:id/representatives") async representatives(
    @Param("slug") slug: string, @Param("id") id: string, @Req() req: FastifyRequest, @Query() query: dto.NetworkingListDto,
  ) {
    return this.service.representatives(await this.context(slug, req), id, query.page);
  }
  @Get("profiles/:id") async profile(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingListDto,
  ) {
    return this.service.viewProfile(await this.context(slug, req), id, query.viewId);
  }
  @Post("interests") async interest(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingInterestDto,
  ) {
    return this.social.interest(
      await this.context(slug, req),
      body.profileId,
      body.action,
    );
  }
  @Delete("interests") async resetInterests(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    return this.social.resetPasses(await this.context(slug, req));
  }
  @Get("connections") async connections(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingParticipantListDto,
  ) {
    return this.social.connections(await this.context(slug, req), query);
  }
  @Get("connections/with/:profileId") async connectionWith(
    @Param("slug") slug: string,
    @Param("profileId") profileId: string,
    @Req() req: FastifyRequest,
  ) {
    return { connection: await this.social.connectionWith(await this.context(slug, req), profileId) };
  }
  @Get("connections/:id") async connection(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.social.connectionSummary(await this.context(slug, req), id);
  }
  @Get("connections/:id/messages") async messages(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingListDto,
  ) {
    return this.social.messages(await this.context(slug, req), id, query);
  }
  @Post("connections/:id/messages")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async message(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingMessageDto,
  ) {
    return this.social.sendMessage(
      await this.context(slug, req),
      id,
      body.body,
      body.clientMessageId,
    );
  }
  @Post("connections/:id/read") async read(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.social.markRead(await this.context(slug, req), id);
  }
  @Get("blocks") async blocks(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    return this.social.blocks(await this.context(slug, req));
  }
  @Post("blocks") async block(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingBlockDto,
  ) {
    return this.social.block(await this.context(slug, req), body.profileId);
  }
  @Delete("blocks/:id") async unblock(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.social.unblock(await this.context(slug, req), id);
  }
  @Post("reports")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async report(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingReportDto,
  ) {
    return this.social.report(await this.context(slug, req), body);
  }
  @Get("availability") async availability(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    return this.meetings.availability(await this.context(slug, req));
  }
  @Put("availability") async updateAvailability(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingAvailabilityDto,
  ) {
    return this.meetings.saveAvailability(
      await this.context(slug, req),
      body.slots,
    );
  }
  @Get("profiles/:id/availability") async profileAvailability(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.meetings.profileAvailability(await this.context(slug, req), id);
  }
  @Get("meetings") async listMeetings(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingParticipantListDto,
  ) {
    return this.meetings.list(await this.context(slug, req), query);
  }
  @Get("meetings/:id") async meeting(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.meetings.get(await this.context(slug, req), id);
  }
  @Post("meetings") async createMeeting(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingMeetingCreateDto,
  ) {
    return this.meetings.create(await this.context(slug, req), body);
  }
  @Post("meetings/:id/respond") async respond(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingMeetingRespondDto,
  ) {
    return this.meetings.respond(await this.context(slug, req), id, body);
  }
  @Post("meetings/:id/checkin") async checkin(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingCheckinDto,
  ) {
    return this.meetings.checkin(await this.context(slug, req), id, body.token);
  }
  @Get("badge") async badge(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    return this.service.badge(await this.context(slug, req));
  }
  @Get("notifications") async notifications(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Query() query: dto.NetworkingListDto,
  ) {
    return this.notificationsService.list(await this.context(slug, req), query);
  }

  @Post("notifications/read") async readNotifications(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingNotificationReadDto,
  ) {
    return this.notificationsService.markRead(await this.context(slug, req), body);
  }
  @Post("push-subscriptions") async subscribe(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: dto.NetworkingPushDto,
  ) {
    return this.notificationsService.subscribePush(await this.context(slug, req), body);
  }
  @Delete("push-subscriptions") async unsubscribe(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Body() body: { endpoint?: string },
  ) {
    return this.notificationsService.unsubscribePush(await this.context(slug, req), body);
  }
  @Get("calendar.ics") @SkipEnvelope() async calendar(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = await this.context(slug, req);
    return reply
      .type("text/calendar; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="networking.ics"')
      .send(await this.exports.calendar(ctx));
  }
  @Get("connections/export") @SkipEnvelope() async exportConnections(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = await this.context(slug, req);
    return reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="connections.csv"')
      .send(await this.exports.connections(ctx));
  }
  @Get("me/export") @SkipEnvelope() async exportMe(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = await this.context(slug, req);
    return reply
      .type("application/json")
      .header(
        "Content-Disposition",
        'attachment; filename="networking-data.json"',
      )
      .send(await this.exports.personal(ctx));
  }
  @Delete("me") async withdraw(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
  ) {
    return this.profileService.withdraw(await this.context(slug, req, { allowConsentPending: true }));
  }
  @Get("stream") @SkipEnvelope() async stream(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return openNotificationStream(reply, { resolveContext: () => this.context(slug, req), lifecycle: this.lifecycle });
  }
}
