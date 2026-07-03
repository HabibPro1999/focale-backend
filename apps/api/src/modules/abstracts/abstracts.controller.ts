import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ErrorCodes,
  UserRole,
  type FinalizeAbstractInput,
  type AddCommitteeMemberInput,
} from "@app/contracts";
import { findEventClientId } from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { assertClientModuleEnabled } from "../clients/module-gates";
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
  ) {}

  /** Resolve event → canAccessClient → module gate (runs on every admin route). */
  private async resolveEvent(eventId: string, user: AuthUser): Promise<void> {
    const event = await findEventClientId(eventId);
    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Event not found",
      });
    }
    if (!canAccessClient(user, event.clientId)) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: "Insufficient permissions",
      });
    }
    await assertClientModuleEnabled(event.clientId, "abstracts");
  }

  // ===========================================================================
  // Config
  // ===========================================================================
  @Get(":eventId/abstracts/config")
  async getConfig(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.config.getOrCreateConfig(eventId);
  }

  @Patch(":eventId/abstracts/config")
  async patchConfig(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Body() body: PatchConfigDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.config.updateConfig(eventId, body, user.id);
  }

  // ===========================================================================
  // Themes
  // ===========================================================================
  @Get(":eventId/abstracts/themes")
  async listThemes(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.config.listThemes(eventId);
  }

  @Post(":eventId/abstracts/themes")
  @HttpCode(201)
  async createTheme(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Body() body: CreateThemeDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.config.createTheme(eventId, body);
  }

  @Patch(":eventId/abstracts/themes/:themeId")
  async updateTheme(
    @Param() { eventId, themeId }: ThemeIdParamDto,
    @Body() body: UpdateThemeDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.config.updateTheme(eventId, themeId, body);
  }

  @Delete(":eventId/abstracts/themes/:themeId")
  @HttpCode(204)
  @SkipEnvelope()
  async deleteTheme(
    @Param() { eventId, themeId }: ThemeIdParamDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.resolveEvent(eventId, user);
    await this.config.softDeleteTheme(eventId, themeId);
  }

  // ===========================================================================
  // Additional fields
  // ===========================================================================
  @Get(":eventId/abstracts/additional-fields")
  async getAdditionalFields(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.config.getAdditionalFields(eventId);
  }

  @Put(":eventId/abstracts/additional-fields")
  async setAdditionalFields(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Body() body: AdditionalFieldsDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.config.setAdditionalFields(eventId, body, user.id);
  }

  // ===========================================================================
  // Admin abstracts
  // ===========================================================================
  @Get(":eventId/abstracts")
  async listAbstracts(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Query() query: ListAbstractsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.admin.listAdminAbstracts(eventId, query);
  }

  @Get(":eventId/abstracts/:abstractId")
  async getAbstract(
    @Param() { eventId, abstractId }: AbstractAdminParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.admin.getAdminAbstract(eventId, abstractId);
  }

  // ===========================================================================
  // Decisions
  // ===========================================================================
  @Post(":eventId/abstracts/:abstractId/finalize")
  async finalize(
    @Param() { eventId, abstractId }: AbstractAdminParamDto,
    @Body() body: FinalizeAbstractDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.admin.finalizeAbstract(
      eventId,
      abstractId,
      body as unknown as FinalizeAbstractInput,
      user.id,
    );
  }

  @Post(":eventId/abstracts/:abstractId/reopen")
  async reopen(
    @Param() { eventId, abstractId }: AbstractAdminParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.admin.reopenAbstract(eventId, abstractId, user.id);
  }

  @Post(":eventId/abstracts/:abstractId/presented")
  async presented(
    @Param() { eventId, abstractId }: AbstractAdminParamDto,
    @Body() body: MarkAbstractPresentedDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
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
  async listCommittee(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.committee.listCommitteeMembers(eventId);
  }

  @Post(":eventId/abstracts/committee")
  @HttpCode(201)
  async addCommittee(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @Body() body: AddCommitteeMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.committee.addCommitteeMember(
      eventId,
      body as unknown as AddCommitteeMemberInput,
      user.id,
    );
  }

  @Delete(":eventId/abstracts/committee/:userId")
  @HttpCode(204)
  @SkipEnvelope()
  async removeCommittee(
    @Param() { eventId, userId }: CommitteeMemberParamDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.resolveEvent(eventId, user);
    await this.committee.removeCommitteeMember(eventId, userId, user.id);
  }

  @Post(":eventId/abstracts/committee/:userId/themes")
  async setReviewerThemes(
    @Param() { eventId, userId }: CommitteeMemberParamDto,
    @Body() body: SetReviewerThemesDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.committee.setReviewerThemes(eventId, userId, body, user.id);
  }

  @Post(":eventId/abstracts/committee/:userId/reset-password")
  @Throttle(PASSWORD_RESET_THROTTLE)
  async resetCommitteePassword(
    @Param() { eventId, userId }: CommitteeMemberParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.committee.resendCommitteeInvite(eventId, userId, user.id);
  }

  @Post(":eventId/abstracts/committee/:userId/set-password")
  @Throttle(PASSWORD_RESET_THROTTLE)
  async setCommitteePassword(
    @Param() { eventId, userId }: CommitteeMemberParamDto,
    @Body() body: SetCommitteeMemberPasswordDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    await this.committee.setCommitteeMemberPassword(
      eventId,
      userId,
      body.password,
      user.id,
    );
    return { ok: true };
  }

  @Post(":eventId/abstracts/:abstractId/assign")
  async assignReviewers(
    @Param() { eventId, abstractId }: AbstractAdminParamDto,
    @Body() body: AssignReviewersDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.committee.assignReviewers(eventId, abstractId, body, user.id);
  }

  // ===========================================================================
  // Abstract Book jobs (PDF generation runs in the worker; routes only
  // enqueue/list/read job rows)
  // ===========================================================================
  @Post(":eventId/abstracts/book/jobs")
  @HttpCode(201)
  async enqueueBookJob(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.book.enqueue(eventId, user.id);
  }

  @Get(":eventId/abstracts/book/jobs")
  async listBookJobs(
    @Param() { eventId }: AbstractsEventIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.book.list(eventId);
  }

  @Get(":eventId/abstracts/book/jobs/:jobId")
  async getBookJob(
    @Param() { eventId, jobId }: AbstractBookJobParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.resolveEvent(eventId, user);
    return this.book.get(eventId, jobId);
  }
}
