import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { prepareAbstractsExport } from "./abstracts.export.service";
import { Throttle } from "@nestjs/throttler";
import {
  UserRole,
  type FinalizeAbstractInput,
  type AddCommitteeMemberInput,
} from "@app/contracts";
import type { ScopedEventRow } from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { type AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { ExportDownloads } from "../../core/exports/stream-download";
import { EventScoped, ScopedEvent } from "../tenancy";
import { AbstractsConfigService } from "./abstracts.config.service";
import { AbstractsAdminService } from "./abstracts.admin.service";
import { AbstractsCommitteeService } from "./abstracts.committee.service";
import { AbstractsBookService } from "./abstracts.book.service";
import {
  AbstractsEventIdParamDto,
  ThemeIdParamDto,
  AbstractAdminParamDto,
  AbstractBookJobParamDto,
  PatchConfigDto,
  CreateThemeDto,
  UpdateThemeDto,
  AdditionalFieldsDto,
  ListAbstractsQueryDto,
  ExportAbstractsQueryDto,
  FinalizeAbstractDto,
  MarkAbstractPresentedDto,
  CommitteeMemberParamDto,
  AddCommitteeMemberDto,
  SetReviewerThemesDto,
  AssignReviewersDto,
  SetCommitteeMemberPasswordDto,
} from "./abstracts.dto";

// Legacy publicRateLimits.passwordReset = 5/min.
const PASSWORD_RESET_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

// requireAdmin: @Auth(CLIENT_ADMIN) = role <= 1 (super_admin or client_admin).
@Controller("api/events")
@Auth(UserRole.CLIENT_ADMIN)
export class AbstractsController {
  constructor(
    private readonly config: AbstractsConfigService,
    private readonly admin: AbstractsAdminService,
    private readonly committee: AbstractsCommitteeService,
    private readonly book: AbstractsBookService,
    private readonly downloads: ExportDownloads,
  ) {}

  // ===========================================================================
  // Config
  // ===========================================================================
  // Streamed through ExportDownloads like the report files: an export slot
  // (503 EXPORT_BUSY when none frees up), then the workbook straight into the
  // response (no Content-Length).
  @Get(":eventId/abstracts/export")
  @EventScoped({ module: "abstracts" })
  @SkipEnvelope()
  async exportAbstracts(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Query() query: ExportAbstractsQueryDto,
    @ScopedEvent() event: ScopedEventRow,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.downloads.stream(reply, () => prepareAbstractsExport(eventId, query, event.slug));
  }

  @Get(":eventId/abstracts/config")
  @EventScoped({ module: "abstracts" })
  async getConfig(
    @Param() { eventId }: AbstractsEventIdParamDto,
  ) {
    return this.config.getOrCreateConfig(eventId);
  }

  @Patch(":eventId/abstracts/config")
  @EventScoped({ module: "abstracts" })
  async patchConfig(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Body() body: PatchConfigDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.config.updateConfig(eventId, body, user.id);
  }

  // ===========================================================================
  // Themes
  // ===========================================================================
  @Get(":eventId/abstracts/themes")
  @EventScoped({ module: "abstracts" })
  async listThemes(
    @Param() { eventId }: AbstractsEventIdParamDto,
  ) {
    return this.config.listThemes(eventId);
  }

  @Post(":eventId/abstracts/themes")
  @EventScoped({ module: "abstracts" })
  @HttpCode(201)
  async createTheme(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Body() body: CreateThemeDto,
  ) {
    return this.config.createTheme(eventId, body);
  }

  @Patch(":eventId/abstracts/themes/:themeId")
  @EventScoped({ module: "abstracts" })
  async updateTheme(
    @Param() { eventId, themeId }: ThemeIdParamDto,
    @Body() body: UpdateThemeDto,
  ) {
    return this.config.updateTheme(eventId, themeId, body);
  }

  @Delete(":eventId/abstracts/themes/:themeId")
  @EventScoped({ module: "abstracts" })
  @HttpCode(204)
  @SkipEnvelope()
  async deleteTheme(
    @Param() { eventId, themeId }: ThemeIdParamDto,
  ): Promise<void> {
    await this.config.softDeleteTheme(eventId, themeId);
  }

  // ===========================================================================
  // Additional fields
  // ===========================================================================
  @Get(":eventId/abstracts/additional-fields")
  @EventScoped({ module: "abstracts" })
  async getAdditionalFields(
    @Param() { eventId }: AbstractsEventIdParamDto,
  ) {
    return this.config.getAdditionalFields(eventId);
  }

  @Put(":eventId/abstracts/additional-fields")
  @EventScoped({ module: "abstracts" })
  async setAdditionalFields(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Body() body: AdditionalFieldsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.config.setAdditionalFields(eventId, body, user.id);
  }

  // ===========================================================================
  // Admin abstracts
  // ===========================================================================
  @Get(":eventId/abstracts")
  @EventScoped({ module: "abstracts" })
  async listAbstracts(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Query() query: ListAbstractsQueryDto,
  ) {
    return this.admin.listAdminAbstracts(eventId, query);
  }

  @Get(":eventId/abstracts/:abstractId")
  @EventScoped({ module: "abstracts" })
  async getAbstract(
    @Param() { eventId, abstractId }: AbstractAdminParamDto,
  ) {
    return this.admin.getAdminAbstract(eventId, abstractId);
  }

  // ===========================================================================
  // Decisions
  // ===========================================================================
  @Post(":eventId/abstracts/:abstractId/finalize")
  @EventScoped({ module: "abstracts" })
  async finalize(
    @Param() { eventId, abstractId }: AbstractAdminParamDto,
    @Body() body: FinalizeAbstractDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.finalizeAbstract(
      eventId,
      abstractId,
      body as unknown as FinalizeAbstractInput,
      user.id,
    );
  }

  @Post(":eventId/abstracts/:abstractId/reopen")
  @EventScoped({ module: "abstracts" })
  async reopen(
    @Param() { eventId, abstractId }: AbstractAdminParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.reopenAbstract(eventId, abstractId, user.id);
  }

  @Post(":eventId/abstracts/:abstractId/presented")
  @EventScoped({ module: "abstracts" })
  async presented(
    @Param() { eventId, abstractId }: AbstractAdminParamDto,
    @Body() body: MarkAbstractPresentedDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.admin.markAbstractPresented(
      eventId,
      abstractId,
      body.presented,
      user.id,
    );
  }

  // ===========================================================================
  // Committee (admin-managed)
  // ===========================================================================
  @Get(":eventId/abstracts/committee")
  @EventScoped({ module: "abstracts" })
  async listCommittee(
    @Param() { eventId }: AbstractsEventIdParamDto,
  ) {
    return this.committee.listCommitteeMembers(eventId);
  }

  @Post(":eventId/abstracts/committee")
  @EventScoped({ module: "abstracts" })
  @HttpCode(201)
  async addCommittee(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Body() body: AddCommitteeMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.committee.addCommitteeMember(
      eventId,
      body as unknown as AddCommitteeMemberInput,
      user.id,
    );
  }

  @Delete(":eventId/abstracts/committee/:userId")
  @EventScoped({ module: "abstracts" })
  @HttpCode(204)
  @SkipEnvelope()
  async removeCommittee(
    @Param() { eventId, userId }: CommitteeMemberParamDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.committee.removeCommitteeMember(eventId, userId, user.id);
  }

  @Post(":eventId/abstracts/committee/:userId/themes")
  @EventScoped({ module: "abstracts" })
  async setReviewerThemes(
    @Param() { eventId, userId }: CommitteeMemberParamDto,
    @Body() body: SetReviewerThemesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.committee.setReviewerThemes(eventId, userId, body, user.id);
  }

  @Post(":eventId/abstracts/committee/:userId/reset-password")
  @EventScoped({ module: "abstracts" })
  @Throttle(PASSWORD_RESET_THROTTLE)
  async resetCommitteePassword(
    @Param() { eventId, userId }: CommitteeMemberParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.committee.resendCommitteeInvite(eventId, userId, user.id);
  }

  @Post(":eventId/abstracts/committee/:userId/set-password")
  @EventScoped({ module: "abstracts" })
  @Throttle(PASSWORD_RESET_THROTTLE)
  async setCommitteePassword(
    @Param() { eventId, userId }: CommitteeMemberParamDto,
    @Body() body: SetCommitteeMemberPasswordDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.committee.setCommitteeMemberPassword(
      eventId,
      userId,
      body.password,
      user,
    );
    return { ok: true };
  }

  @Post(":eventId/abstracts/:abstractId/assign")
  @EventScoped({ module: "abstracts" })
  async assignReviewers(
    @Param() { eventId, abstractId }: AbstractAdminParamDto,
    @Body() body: AssignReviewersDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.committee.assignReviewers(eventId, abstractId, body, user.id);
  }

  // ===========================================================================
  // Abstract Book jobs (PDF generation runs in the worker; routes only
  // enqueue/list/read job rows)
  // ===========================================================================
  @Post(":eventId/abstracts/book/jobs")
  @EventScoped({ module: "abstracts" })
  @HttpCode(201)
  async enqueueBookJob(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.book.enqueue(eventId, user.id);
  }

  @Get(":eventId/abstracts/book/jobs")
  @EventScoped({ module: "abstracts" })
  async listBookJobs(
    @Param() { eventId }: AbstractsEventIdParamDto,
  ) {
    return this.book.list(eventId);
  }

  @Get(":eventId/abstracts/book/jobs/:jobId")
  @EventScoped({ module: "abstracts" })
  async getBookJob(
    @Param() { eventId, jobId }: AbstractBookJobParamDto,
  ) {
    return this.book.get(eventId, jobId);
  }
}
