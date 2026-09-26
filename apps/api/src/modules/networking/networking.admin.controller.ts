import * as responses from "@app/contracts";
import { ResponseContract } from "../../core/response-contract";
import { EventScoped } from "../tenancy/tenant-scope";
import {
  Body,
  NotFoundException,
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
import { getEventWithPricing, getNetworkingEventSyncState, listNetworkingAdminAudit, requestNetworkingEventSync } from "@app/db";
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
  ) {}

  @ResponseContract(responses.NetworkingAdminConfigResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("config") async config(
    @Param("eventId") eventId: string,
  ) {
    return this.service.config(eventId);
  }
  @ResponseContract(responses.NetworkingAdminUpdateConfigResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Patch("config") async updateConfig(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Body() body: dto.NetworkingConfigDto,
  ) {
    return this.service.config(eventId, body, user.id);
  }
  @ResponseContract(responses.NetworkingAdminUploadLogoResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Post("branding/logo")
  async uploadLogo(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Req() request: NetworkingMultipartRequest,
  ) {
    const config = await this.service.config(eventId);
    return this.uploads.image(
      request,
      `networking/${eventId}/branding`,
      (url) => this.service.config(eventId, { logoUrl: url }, user.id),
      config.logoUrl,
    );
  }
  /**
   * Starts a full re-projection of the event's registrations in the worker
   * (plan 4.8): 202 with the new run's state; GET follows its progress.
   */
  @ResponseContract(responses.NetworkingAdminSyncResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Post("sync")
  @HttpCode(202)
  async sync(
    @Param("eventId") eventId: string,
  ) {
    return requestNetworkingEventSync(eventId);
  }
  @ResponseContract(responses.NetworkingAdminSyncStateResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("sync") async syncState(
    @Param("eventId") eventId: string,
  ) {
    return getNetworkingEventSyncState(eventId);
  }
  @ResponseContract(responses.NetworkingAdminProfilesResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("profiles") async profiles(
    @Param("eventId") eventId: string,
    @Query() query: dto.NetworkingListDto,
  ) {
    return this.service.profiles(eventId, query);
  }
  @ResponseContract(responses.NetworkingAdminUpdateProfileResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Patch("profiles/:id") async updateProfile(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("id") id: string,
    @Body() body: dto.NetworkingAdminProfileDto,
  ) {
    return this.service.updateProfile(eventId, id, body, user.id);
  }
  @ResponseContract(responses.NetworkingAdminSpacesResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("spaces") async spaces(@Param("eventId") eventId: string) {
    return this.service.inventory.spaces(eventId);
  }
  @ResponseContract(responses.NetworkingAdminCreateSpaceResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Post("spaces") async createSpace(@CurrentUser() user: AuthUser, @Param("eventId") eventId: string, @Body() body: dto.NetworkingSpaceDto) {
    return this.service.inventory.saveSpace(eventId, body, user.id);
  }
  @ResponseContract(responses.NetworkingAdminUpdateSpaceResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Patch("spaces/:id") async updateSpace(@CurrentUser() user: AuthUser, @Param("eventId") eventId: string, @Param("id") id: string, @Body() body: dto.NetworkingSpaceUpdateDto) {
    return this.service.inventory.saveSpace(eventId, body, user.id, id);
  }
  @ResponseContract(responses.NetworkingAdminRemoveSpaceResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Delete("spaces/:id") async removeSpace(@CurrentUser() user: AuthUser, @Param("eventId") eventId: string, @Param("id") id: string) {
    return this.service.inventory.removeSpace(eventId, id, user.id);
  }
  @ResponseContract(responses.NetworkingAdminTablesResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("tables") async tables(
    @Param("eventId") eventId: string,
  ) {
    return this.service.tables(eventId);
  }
  @ResponseContract(responses.NetworkingAdminTableResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Post("tables") async table(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Body() body: dto.NetworkingTableDto,
  ) {
    return this.service.saveTable(eventId, body, user.id);
  }
  @ResponseContract(responses.NetworkingAdminUpdateTableResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Patch("tables/:id") async updateTable(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("id") id: string,
    @Body() body: dto.NetworkingTableUpdateDto,
  ) {
    return this.service.saveTable(eventId, body, user.id, id);
  }
  @ResponseContract(responses.NetworkingAdminRemoveTableResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Delete("tables/:id") async removeTable(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("id") id: string,
  ) {
    return this.service.removeTable(eventId, id, user.id);
  }
  @ResponseContract(responses.NetworkingAdminMeetingsResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("meetings") async meetings(
    @Param("eventId") eventId: string,
    @Query() query: dto.NetworkingListDto,
  ) {
    return this.service.listMeetings(eventId, query);
  }
  @ResponseContract(responses.NetworkingAdminCalendarResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("meetings/calendar") async calendar(
    @Param("eventId") eventId: string,
    @Query() query: dto.NetworkingCalendarDto,
  ) {
    return this.service.calendar(eventId, query);
  }
  @ResponseContract(responses.NetworkingAdminUpdateMeetingResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Patch("meetings/:id") async updateMeeting(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("id") id: string,
    @Body() body: dto.NetworkingAdminMeetingDto,
  ) {
    return this.service.updateMeeting(eventId, id, body, user.id);
  }
  @ResponseContract(responses.NetworkingAdminReportsResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("reports") async reports(
    @Param("eventId") eventId: string,
    @Query() query: dto.NetworkingListDto,
  ) {
    return this.service.reports(eventId, query);
  }
  @ResponseContract(responses.NetworkingAdminModerateResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Patch("reports/:id") async moderate(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("id") id: string,
    @Body() body: dto.NetworkingReportActionDto,
  ) {
    return this.service.moderate(eventId, id, body, user.id);
  }
  @ResponseContract(responses.NetworkingAdminAuditResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("audit") async audit(
    @Param("eventId") eventId: string,
    @Query() query: dto.NetworkingListDto,
  ) {
    // One page in SQL, organizer actions only: participant activity is never listed.
    return listNetworkingAdminAudit(eventId, query);
  }
  @ResponseContract(responses.NetworkingAdminVerifyBadgeResponseSchema)
  @EventScoped({ module: "networking" })
  @Post("badges/verify")
  async verifyBadge(
    @Param("eventId") eventId: string,
    @Body() body: dto.NetworkingBadgeVerifyDto,
  ) {
    return this.service.verifyBadge(eventId, body.token, body.accessId);
  }
  @ResponseContract(responses.NetworkingAdminRegeneratePostEventReportResponseSchema)
  @EventScoped({ module: "networking", write: true })
  @Post("post-event-report")
  @HttpCode(202)
  async regeneratePostEventReport(@CurrentUser() user: AuthUser, @Param("eventId") eventId: string) {
    return this.service.regeneratePostEventReport(eventId, user.id);
  }
  @ResponseContract(responses.NetworkingAdminPostEventReportResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("post-event-report")
  async postEventReport(@Param("eventId") eventId:string){return this.service.postEventReport(eventId);}
  @ResponseContract(responses.NetworkingAdminAnalyticsResponseSchema)
  @EventScoped({ module: "networking" })
  @Get("analytics") async analytics(
    @Param("eventId") eventId: string,
  ) {
    return this.service.analytics(eventId);
  }
  @EventScoped({ module: "networking" })
  @Get("export") @SkipEnvelope() async export(
    @Param("eventId") eventId: string,
    @Query("kind") kind: string,
    @Query("format") format: string,
    @Res() reply: FastifyReply,
  ) {
    const event = await getEventWithPricing(eventId);
    if (!event) throw new NotFoundException({ code: responses.ErrorCodes.NOT_FOUND, message: "Event not found" });
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
