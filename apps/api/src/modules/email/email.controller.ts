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
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ErrorCodes } from "@app/contracts";
import { getEventWithPricing, type EventWithPricing } from "@app/db";
import { getAvailableVariables, type VariableDefinition } from "@app/integrations";
import type { PaginatedResult } from "@app/shared";
import { Auth } from "../../core/auth/auth.decorator";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { assertEventWritable } from "../events/events.service";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { AppException } from "../../core/app-exception";
import { EmailTemplateService } from "./email-template.service";
import { EmailSendService } from "./email-send.service";
import {
  CreateEmailTemplateBodyDto,
  UpdateEmailTemplateDto,
  ListEmailTemplatesQueryDto,
  ListEventEmailLogsQueryDto,
  TestSendEmailDto,
  BulkSendEmailDto,
  SendCustomEmailDto,
  EmailEventIdParamDto,
  EmailTemplateIdParamDto,
  BulkSendParamDto,
  SendCustomEmailParamDto,
} from "./dto";

// Every route requires a valid Bearer token (any role); per-handler
// canAccessClient does the tenant check (legacy `requireAuth` + canAccessClient,
// no requireAdmin).
@Controller("api/events")
@Auth()
export class EmailController {
  constructor(
    private readonly templates: EmailTemplateService,
    private readonly send: EmailSendService,
  ) {}

  // ==========================================================================
  // Shared guards
  // ==========================================================================
  private async resolveEvent(eventId: string): Promise<EventWithPricing> {
    const event = await getEventWithPricing(eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    return event;
  }

  private assertAccess(user: AuthUser, clientId: string): void {
    if (!canAccessClient(user, clientId)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Insufficient permissions",
        403,
      );
    }
  }

  private async assertEmailFeatureWritable(
    event: EventWithPricing,
  ): Promise<void> {
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "emails");
  }

  /** Load a template + its event, mirroring legacy getTemplateWriteContext. */
  private async getTemplateWriteContext(templateId: string) {
    const template = await this.templates.getById(templateId);
    if (!template) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Email template not found",
        404,
      );
    }
    if (!template.eventId) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "Email template is not event-scoped",
        400,
      );
    }
    const event = await this.resolveEvent(template.eventId);
    return { template, event };
  }

  // ==========================================================================
  // EMAIL TEMPLATES
  // ==========================================================================

  @Get(":eventId/email-templates")
  async list(
    @Param() params: EmailEventIdParamDto,
    @Query() query: ListEmailTemplatesQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResult<unknown>> {
    const event = await this.resolveEvent(params.eventId);
    this.assertAccess(user, event.clientId);
    await assertClientModuleEnabled(event.clientId, "emails");
    return this.templates.list(params.eventId, query);
  }

  @Get(":eventId/email-templates/variables")
  async variables(
    @Param() params: EmailEventIdParamDto,
    @CurrentUser() user: AuthUser,
  ): Promise<VariableDefinition[]> {
    const event = await this.resolveEvent(params.eventId);
    this.assertAccess(user, event.clientId);
    await assertClientModuleEnabled(event.clientId, "emails");
    return getAvailableVariables(params.eventId);
  }

  @Post(":eventId/email-templates")
  @HttpCode(201)
  async create(
    @Param() params: EmailEventIdParamDto,
    @Body() body: CreateEmailTemplateBodyDto,
    @CurrentUser() user: AuthUser,
  ) {
    const event = await this.resolveEvent(params.eventId);
    this.assertAccess(user, event.clientId);
    await this.assertEmailFeatureWritable(event);
    return this.templates.create({
      clientId: event.clientId,
      eventId: params.eventId,
      ...body,
    });
  }

  @Get("email-templates/:templateId")
  async getOne(
    @Param() params: EmailTemplateIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    const template = await this.templates.getById(params.templateId);
    if (!template) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Email template not found",
        404,
      );
    }
    this.assertAccess(user, template.clientId);
    if (template.eventId) {
      const event = await this.resolveEvent(template.eventId);
      await assertClientModuleEnabled(event.clientId, "emails");
    }
    return template;
  }

  @Patch("email-templates/:templateId")
  async update(
    @Param() params: EmailTemplateIdParamDto,
    @Body() body: UpdateEmailTemplateDto,
    @CurrentUser() user: AuthUser,
  ) {
    const { event } = await this.getTemplateWriteContext(params.templateId);
    this.assertAccess(user, event.clientId);
    await this.assertEmailFeatureWritable(event);
    return this.templates.update(params.templateId, body);
  }

  @Delete("email-templates/:templateId")
  @HttpCode(204)
  @SkipEnvelope()
  async remove(
    @Param() params: EmailTemplateIdParamDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    const { event } = await this.getTemplateWriteContext(params.templateId);
    this.assertAccess(user, event.clientId);
    await this.assertEmailFeatureWritable(event);
    await this.templates.delete(params.templateId);
  }

  @Post("email-templates/:templateId/duplicate")
  @HttpCode(201)
  async duplicate(
    @Param() params: EmailTemplateIdParamDto,
    @Body() body: { name?: string } | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const { event } = await this.getTemplateWriteContext(params.templateId);
    this.assertAccess(user, event.clientId);
    await this.assertEmailFeatureWritable(event);
    return this.templates.duplicate(params.templateId, body?.name);
  }

  @Post("email-templates/:templateId/test-send")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async testSend(
    @Param() params: EmailTemplateIdParamDto,
    @Body() body: TestSendEmailDto,
    @CurrentUser() user: AuthUser,
  ) {
    const { template, event } = await this.getTemplateWriteContext(
      params.templateId,
    );
    this.assertAccess(user, template.clientId);
    await this.assertEmailFeatureWritable(event);
    return this.send.testSend(template, body.recipientEmail, body.recipientName);
  }

  // ==========================================================================
  // EVENT EMAIL LOGS
  // ==========================================================================

  @Get(":eventId/email-logs")
  async listLogs(
    @Param() params: EmailEventIdParamDto,
    @Query() query: ListEventEmailLogsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const event = await this.resolveEvent(params.eventId);
    this.assertAccess(user, event.clientId);
    await assertClientModuleEnabled(event.clientId, "emails");
    return this.templates.listLogs(params.eventId, query);
  }

  // ==========================================================================
  // BULK SEND + CUSTOM SEND
  // ==========================================================================

  @Post(":eventId/email-templates/:templateId/send")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async bulkSend(
    @Param() params: BulkSendParamDto,
    @Body() body: BulkSendEmailDto,
    @CurrentUser() user: AuthUser,
  ) {
    const event = await this.resolveEvent(params.eventId);
    this.assertAccess(user, event.clientId);
    await this.assertEmailFeatureWritable(event);

    const template = await this.templates.getById(params.templateId);
    if (!template) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Email template not found",
        404,
      );
    }
    if (template.clientId !== event.clientId) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Template does not belong to this client",
        403,
      );
    }

    return this.send.bulkSend(event, params.templateId, body);
  }

  @Post(":eventId/registrations/:registrationId/send-custom-email")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async sendCustom(
    @Param() params: SendCustomEmailParamDto,
    @Body() body: SendCustomEmailDto,
    @CurrentUser() user: AuthUser,
  ) {
    const event = await this.resolveEvent(params.eventId);
    this.assertAccess(user, event.clientId);
    await this.assertEmailFeatureWritable(event);
    return this.send.sendCustom(
      event,
      params.registrationId,
      body.subject,
      body.content,
    );
  }
}
