import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Body,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { assertEventAccess } from "../../core/auth/assert-event-access";
import { type AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { ExportDownloads } from "../../core/exports/stream-download";
import { ReportsService } from "./reports.service";
import {
  prepareAccessRegistrantsReport,
  prepareCheckInReport,
  prepareEventSummary,
  prepareSponsorshipsReport,
} from "./excel-generator";
import { prepareRegistrationsWorkbook } from "./registrations-export-builder";
import {
  ReportQueryDto,
  ExportRegistrationsQueryDto,
  ExportRegistrationsBodyDto,
  ExportSponsorshipsQueryDto,
} from "./reports.dto";

/**
 * Reports routes, mounted at /api/events. Every route requires a valid token
 * (@Auth); per-route ownership is enforced inline by re-fetching the event and
 * running canAccessClient against its clientId (client-admin/super-admin only —
 * NOT a guard, replicated per handler exactly as legacy). File endpoints run
 * through ExportDownloads (@SkipEnvelope): after authorization they wait for an
 * export slot (503 EXPORT_BUSY when none frees up), then stream the file with
 * the legacy Content-Type / Content-Disposition headers and no Content-Length.
 */
@Auth()
@Controller("api/events")
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly downloads: ExportDownloads,
  ) {}

  private async authorizeEvent(user: AuthUser, eventId: string): Promise<void> {
    await assertEventAccess(user, eventId);
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
    await this.downloads.stream(reply, () => this.reports.exportRegistrations(eventId, query));
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
    await this.downloads.stream(reply, () => prepareRegistrationsWorkbook(eventId, body));
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
    await this.downloads.stream(reply, () => prepareAccessRegistrantsReport(eventId));
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
    await this.downloads.stream(reply, () => prepareSponsorshipsReport(eventId, query));
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
    await this.downloads.stream(reply, () => prepareCheckInReport(eventId));
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
    await this.downloads.stream(reply, () => prepareEventSummary(eventId));
  }
}
