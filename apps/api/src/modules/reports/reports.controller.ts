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
import { EventScoped } from "../tenancy";
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
 * (@Auth); `@EventScoped()` checks the event exists (404) and belongs to the
 * caller's client (403, client-admin/super-admin only); the sponsorships
 * export also needs the sponsorships module (plan 5.4). File endpoints run
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

  // ----------------------------------------------------------------
  // GET /:eventId/analytics
  // ----------------------------------------------------------------
  @Get(":eventId/analytics")
  @EventScoped()
  async analytics(@Param("eventId") eventId: string) {
    return this.reports.getEventAnalytics(eventId);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/analytics/access-items/:accessId/registrations
  // ----------------------------------------------------------------
  @Get(":eventId/analytics/access-items/:accessId/registrations")
  @EventScoped()
  async accessRegistrants(
    @Param("eventId") eventId: string,
    @Param("accessId") accessId: string,
  ) {
    return this.reports.getAccessRegistrants(eventId, accessId);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/financial
  // ----------------------------------------------------------------
  @Get(":eventId/reports/financial")
  @EventScoped()
  async financial(
    @Param("eventId") eventId: string,
    @Query() query: ReportQueryDto,
  ) {
    return this.reports.getFinancialReport(eventId, query);
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/registrations — CSV/JSON/XLSX export
  // ----------------------------------------------------------------
  @Get(":eventId/reports/registrations")
  @EventScoped()
  @SkipEnvelope()
  async exportRegistrations(
    @Param("eventId") eventId: string,
    @Query() query: ExportRegistrationsQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.downloads.stream(reply, () => this.reports.exportRegistrations(eventId, query));
  }

  // ----------------------------------------------------------------
  // POST /:eventId/reports/registrations/export — modular xlsx export
  // ----------------------------------------------------------------
  @Post(":eventId/reports/registrations/export")
  @EventScoped()
  @SkipEnvelope()
  async modularExport(
    @Param("eventId") eventId: string,
    @Body() body: ExportRegistrationsBodyDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.downloads.stream(reply, () => prepareRegistrationsWorkbook(eventId, body));
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/access-registrants — one sheet per access item
  // ----------------------------------------------------------------
  @Get(":eventId/reports/access-registrants")
  @EventScoped()
  @SkipEnvelope()
  async accessRegistrantsReport(
    @Param("eventId") eventId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.downloads.stream(reply, () => prepareAccessRegistrantsReport(eventId));
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/sponsorships — flat sponsorship export
  // ----------------------------------------------------------------
  @Get(":eventId/reports/sponsorships")
  @EventScoped({ module: "sponsorships" })
  @SkipEnvelope()
  async sponsorshipsReport(
    @Param("eventId") eventId: string,
    @Query() query: ExportSponsorshipsQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.downloads.stream(reply, () => prepareSponsorshipsReport(eventId, query));
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/checkin-export — check-in ZIP
  // ----------------------------------------------------------------
  @Get(":eventId/reports/checkin-export")
  @EventScoped()
  @SkipEnvelope()
  async checkinExport(
    @Param("eventId") eventId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.downloads.stream(reply, () => prepareCheckInReport(eventId));
  }

  // ----------------------------------------------------------------
  // GET /:eventId/reports/summary — event summary xlsx
  // ----------------------------------------------------------------
  @Get(":eventId/reports/summary")
  @EventScoped()
  @SkipEnvelope()
  async summary(
    @Param("eventId") eventId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.downloads.stream(reply, () => prepareEventSummary(eventId));
  }
}
