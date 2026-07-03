import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Body,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { getEventWithPricing } from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { ReportsService } from "./reports.service";
import {
  ReportQueryDto,
  ExportRegistrationsQueryDto,
  ExportRegistrationsBodyDto,
  ExportSponsorshipsQueryDto,
} from "./reports.dto";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Reports routes, mounted at /api/events. Every route requires a valid token
 * (@Auth); per-route ownership is enforced inline by re-fetching the event and
 * running canAccessClient against its clientId (client-admin/super-admin only —
 * NOT a guard, replicated per handler exactly as legacy). File endpoints stream
 * raw binary/text with @SkipEnvelope + exact legacy headers.
 */
@Auth()
@Controller("api/events")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  private async authorizeEvent(user: AuthUser, eventId: string): Promise<void> {
    const event = await getEventWithPricing(eventId);
    if (!event) throw new NotFoundException("Event not found");
    if (!canAccessClient(user, event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
  }

  // Shared file-download tail: sanitize the filename and stream the payload
  // with the exact legacy Content-Type / Content-Disposition headers.
  private async sendDownload(
    reply: FastifyReply,
    contentType: string,
    filename: string,
    data: string | Buffer,
  ): Promise<void> {
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    await reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", `attachment; filename="${safeFilename}"`)
      .send(data);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/analytics
  // ----------------------------------------------------------------
  @Get(":eventId/analytics")
  async analytics(@CurrentUser() user: AuthUser, @Param("eventId") eventId: string) {
    await this.authorizeEvent(user, eventId);
    return this.reports.getEventAnalytics(eventId);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/analytics/access-items/:accessId/registrations
  // ----------------------------------------------------------------
  @Get(":eventId/analytics/access-items/:accessId/registrations")
  async accessRegistrants(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Param("accessId") accessId: string,
  ) {
    await this.authorizeEvent(user, eventId);
    return this.reports.getAccessRegistrants(eventId, accessId);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/financial
  // ----------------------------------------------------------------
  @Get(":eventId/reports/financial")
  async financial(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Query() query: ReportQueryDto,
  ) {
    await this.authorizeEvent(user, eventId);
    return this.reports.getFinancialReport(eventId, query);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/registrations — CSV/JSON/XLSX export
  // ----------------------------------------------------------------
  @Get(":eventId/reports/registrations")
  @SkipEnvelope()
  async exportRegistrations(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Query() query: ExportRegistrationsQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.authorizeEvent(user, eventId);
    const result = await this.reports.exportRegistrations(eventId, query);
    await this.sendDownload(reply, result.contentType, result.filename, result.data);
  }

  // ----------------------------------------------------------------
  // POST /:eventId/reports/registrations/export — modular xlsx export
  // ----------------------------------------------------------------
  @Post(":eventId/reports/registrations/export")
  @SkipEnvelope()
  async modularExport(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Body() body: ExportRegistrationsBodyDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.authorizeEvent(user, eventId);
    const result = await this.reports.buildRegistrationsWorkbook(eventId, body);
    await this.sendDownload(reply, XLSX_CONTENT_TYPE, result.filename, result.data);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/access-registrants — one sheet per access item
  // ----------------------------------------------------------------
  @Get(":eventId/reports/access-registrants")
  @SkipEnvelope()
  async accessRegistrantsReport(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.authorizeEvent(user, eventId);
    const result = await this.reports.generateAccessRegistrantsReport(eventId);
    await this.sendDownload(reply, XLSX_CONTENT_TYPE, result.filename, result.data);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/sponsorships — flat sponsorship export
  // ----------------------------------------------------------------
  @Get(":eventId/reports/sponsorships")
  @SkipEnvelope()
  async sponsorshipsReport(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Query() query: ExportSponsorshipsQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.authorizeEvent(user, eventId);
    const result = await this.reports.generateSponsorshipsReport(eventId, query);
    await this.sendDownload(reply, XLSX_CONTENT_TYPE, result.filename, result.data);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/checkin-export — check-in ZIP
  // ----------------------------------------------------------------
  @Get(":eventId/reports/checkin-export")
  @SkipEnvelope()
  async checkinExport(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.authorizeEvent(user, eventId);
    const result = await this.reports.generateCheckInReport(eventId);
    await this.sendDownload(reply, "application/zip", result.filename, result.data);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/summary — event summary xlsx
  // ----------------------------------------------------------------
  @Get(":eventId/reports/summary")
  @SkipEnvelope()
  async summary(
    @CurrentUser() user: AuthUser,
    @Param("eventId") eventId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.authorizeEvent(user, eventId);
    const result = await this.reports.generateEventSummary(eventId);
    await this.sendDownload(reply, XLSX_CONTENT_TYPE, result.filename, result.data);
  }
}
