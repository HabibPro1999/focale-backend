import { networkingOrganizerAccess } from "./networking.organizer-access";
import { NetworkingInventoryService } from "./networking.inventory.service";
import { networkingAnalytics } from "./networking.analytics";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  Req,
  UseInterceptors,
} from "@nestjs/common";
import { NetworkingBusyInterceptor } from "./networking.busy";
import {
  NetworkingUploadsService,
  type NetworkingMultipartRequest,
} from "./networking.uploads.service";
import type { FastifyReply } from "fastify";
import { syncNetworkingEvent } from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import type { AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { NetworkingAdminService } from "./networking.admin.service";
import { NetworkingExportsService } from "./networking.exports.service";
import * as dto from "./networking.dto";
@Auth()
@UseInterceptors(NetworkingBusyInterceptor)
@Controller("api/events/:eventId/networking")
export class NetworkingAdminController {
  constructor(
    private readonly uploads: NetworkingUploadsService,
    private readonly service: NetworkingAdminService,
    private readonly exports: NetworkingExportsService,
    private readonly inventory: NetworkingInventoryService,
  ) {}

  @Get("config") async config(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
  ) {
    await networkingOrganizerAccess(user, eventId);
    return this.service.getConfig(eventId);
  }
  @Patch("config") async updateConfig(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Body() body: dto.NetworkingConfigDto,
  ) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.service.updateConfig(eventId, body, user.id);
  }
  @Post("branding/logo")
  async uploadLogo(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Req() request: NetworkingMultipartRequest,
  ) {
    await networkingOrganizerAccess(user, eventId, true);
    const config = await this.service.getConfig(eventId);
    return this.uploads.image(
      request,
      `networking/${eventId}/branding`,
      (url) => this.service.updateConfig(eventId, { logoUrl: url }, user.id),
      config.logoUrl,
    );
  }
  @Post("sync") async sync(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
  ) {
    await networkingOrganizerAccess(user, eventId, true);
    return syncNetworkingEvent(eventId);
  }
  @Get("profiles") async profiles(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Query() query: dto.NetworkingListDto,
  ) {
    await networkingOrganizerAccess(user, eventId);
    return this.service.profiles(eventId, query);
  }
  @Patch("profiles/:id") async updateProfile(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("id") id: string,
    @Body() body: dto.NetworkingAdminProfileDto,
  ) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.service.updateProfile(eventId, id, body, user.id);
  }
  @Get("spaces") async spaces(@CurrentUser() user: AuthUser, @Param("eventId") eventId: string) {
    await networkingOrganizerAccess(user, eventId);
    return this.inventory.spaces(eventId);
  }
  @Post("spaces") async createSpace(@CurrentUser() user: AuthUser, @Param("eventId") eventId: string, @Body() body: dto.NetworkingSpaceDto) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.inventory.saveSpace(eventId, body, user.id);
  }
  @Patch("spaces/:id") async updateSpace(@CurrentUser() user: AuthUser, @Param("eventId") eventId: string, @Param("id") id: string, @Body() body: dto.NetworkingSpaceUpdateDto) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.inventory.saveSpace(eventId, body, user.id, id);
  }
  @Delete("spaces/:id") async removeSpace(@CurrentUser() user: AuthUser, @Param("eventId") eventId: string, @Param("id") id: string) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.inventory.removeSpace(eventId, id, user.id);
  }
  @Get("tables") async tables(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
  ) {
    await networkingOrganizerAccess(user, eventId);
    return this.inventory.tables(eventId);
  }
  @Post("tables") async table(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Body() body: dto.NetworkingTableDto,
  ) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.inventory.saveTable(eventId, body, user.id);
  }
  @Patch("tables/:id") async updateTable(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("id") id: string,
    @Body() body: dto.NetworkingTableUpdateDto,
  ) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.inventory.saveTable(eventId, body, user.id, id);
  }
  @Delete("tables/:id") async removeTable(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("id") id: string,
  ) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.inventory.removeTable(eventId, id, user.id);
  }
  @Get("meetings") async meetings(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Query() query: dto.NetworkingListDto,
  ) {
    await networkingOrganizerAccess(user, eventId);
    return this.service.listMeetings(eventId, query);
  }
  @Get("meetings/calendar") async calendar(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Query() query: dto.NetworkingCalendarDto,
  ) {
    await networkingOrganizerAccess(user, eventId);
    return this.service.calendar(eventId, query);
  }
  @Patch("meetings/:id") async updateMeeting(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("id") id: string,
    @Body() body: dto.NetworkingAdminMeetingDto,
  ) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.service.updateMeeting(eventId, id, body, user.id);
  }
  @Get("reports") async reports(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Query() query: dto.NetworkingListDto,
  ) {
    await networkingOrganizerAccess(user, eventId);
    return this.service.reports(eventId, query);
  }
  @Patch("reports/:id") async moderate(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("id") id: string,
    @Body() body: dto.NetworkingReportActionDto,
  ) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.service.moderate(eventId, id, body, user.id);
  }
  @Get("audit") async audit(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Query() query: dto.NetworkingListDto,
  ) {
    await networkingOrganizerAccess(user, eventId);
    return this.service.audit(eventId, query);
  }
  @Post("badges/verify")
  async verifyBadge(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Body() body: dto.NetworkingBadgeVerifyDto,
  ) {
    await networkingOrganizerAccess(user, eventId);
    return this.service.verifyBadge(eventId, body.token, body.accessId);
  }
  @Post("post-event-report")
  @HttpCode(202)
  async regeneratePostEventReport(@CurrentUser() user: AuthUser, @Param("eventId") eventId: string) {
    await networkingOrganizerAccess(user, eventId, true);
    return this.service.regeneratePostEventReport(eventId, user.id);
  }
  @Get("post-event-report")
  async postEventReport(@CurrentUser() user:AuthUser,@Param("eventId") eventId:string){await networkingOrganizerAccess(user,eventId);return this.service.postEventReport(eventId);}
  @Get("analytics") async analytics(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
  ) {
    await networkingOrganizerAccess(user, eventId);
    return networkingAnalytics(eventId);
  }
  @Get("export") @SkipEnvelope() async export(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Query("kind") kind: string,
    @Query("format") format: string,
    @Res() reply: FastifyReply,
  ) {
    const event = await networkingOrganizerAccess(user, eventId);
    const file = await this.exports.admin(event, kind, format);
    return reply
      .type(file.contentType)
      .header(
        "Content-Disposition",
        `attachment; filename="networking-${file.kind}.${file.format}"`,
      )
      .send(file.body);
  }
}
