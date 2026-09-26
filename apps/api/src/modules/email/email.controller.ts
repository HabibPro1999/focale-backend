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
import {
  getEventWithPricing,
  type EventWithPricing,
  type ScopedEventRow,
} from "@app/db";
import { getAvailableVariables, type VariableDefinition } from "@app/integrations";
import type { PaginatedResult } from "@app/shared";
import { Auth } from "../../core/auth/auth.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { AppException } from "../../core/app-exception";
import { EmailTemplateScoped, EventScoped, ScopedEvent } from "../tenancy";
import { EmailTemplateService } from "./email-template.service";
import { EmailSendService } from "./email-send.service";
import {
  CreateEmailTemplateBodyDto,
  DuplicateEmailTemplateDto,
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
  ResendEmailLogParamDto,
} from "./dto";

// Every route requires a valid Bearer token (any role); the tenant check is the
// route's scope guard (`@EventScoped` / `@EmailTemplateScoped`, plan 5.4):
// 404 → 403 (canAccessClient) → archived (writes) → emails module gate.
@Controller("api/events")
@Auth()
export class EmailController {
  constructor(
    private readonly templates: EmailTemplateService,
    private readonly send: EmailSendService,
  ) {}

  /** The event with the fields the send paths need (after the scope guard). */
  private async eventForSend(eventId: string): Promise<EventWithPricing> {
    const event = await getEventWithPricing(eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    return event;
  }

  private async template(templateId: string) {
    const template = await this.templates.getById(templateId);
    if (!template) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Email template not found",
        404,
      );
    }
    return template;
  }

  // ==========================================================================
  // EMAIL TEMPLATES
  // ==========================================================================

  @Get(":eventId/email-templates")
  @EventScoped({ module: "emails" })
  async list(
    @Param() params: EmailEventIdParamDto,
    @Query() query: ListEmailTemplatesQueryDto,
  ): Promise<PaginatedResult<unknown>> {
    return this.templates.list(params.eventId, query);
  }

  @Get(":eventId/email-templates/variables")
  @EventScoped({ module: "emails" })
  async variables(
    @Param() params: EmailEventIdParamDto,
  ): Promise<VariableDefinition[]> {
    return getAvailableVariables(params.eventId);
  }

  @Post(":eventId/email-templates")
  @EventScoped({ module: "emails", write: true })
  @HttpCode(201)
  async create(
    @Param() params: EmailEventIdParamDto,
    @Body() body: CreateEmailTemplateBodyDto,
    @ScopedEvent() event: ScopedEventRow,
  ) {
    return this.templates.create({
      clientId: event.clientId,
      eventId: params.eventId,
      ...body,
    });
  }

  @Get("email-templates/:templateId")
  @EmailTemplateScoped({ module: "emails" })
  async getOne(@Param() params: EmailTemplateIdParamDto) {
    return this.template(params.templateId);
  }

  @Patch("email-templates/:templateId")
  @EmailTemplateScoped({ module: "emails", write: true })
  async update(
    @Param() params: EmailTemplateIdParamDto,
    @Body() body: UpdateEmailTemplateDto,
  ) {
    return this.templates.update(params.templateId, body);
  }

  @Delete("email-templates/:templateId")
  @EmailTemplateScoped({ module: "emails", write: true })
  @HttpCode(204)
  @SkipEnvelope()
  async remove(@Param() params: EmailTemplateIdParamDto): Promise<void> {
    await this.templates.delete(params.templateId);
  }

  @Post("email-templates/:templateId/duplicate")
  @EmailTemplateScoped({ module: "emails", write: true })
  @HttpCode(201)
  async duplicate(
    @Param() params: EmailTemplateIdParamDto,
    @Body() body: DuplicateEmailTemplateDto,
  ) {
    return this.templates.duplicate(params.templateId, body.name);
  }

  @Post("email-templates/:templateId/test-send")
  @EmailTemplateScoped({ module: "emails", write: true })
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async testSend(
    @Param() params: EmailTemplateIdParamDto,
    @Body() body: TestSendEmailDto,
  ) {
    const template = await this.template(params.templateId);
    return this.send.testSend(template, body.recipientEmail, body.recipientName);
  }

  // ==========================================================================
  // EVENT EMAIL LOGS
  // ==========================================================================

  @Get(":eventId/email-logs")
  @EventScoped({ module: "emails" })
  async listLogs(
    @Param() params: EmailEventIdParamDto,
    @Query() query: ListEventEmailLogsQueryDto,
  ) {
    return this.templates.listLogs(params.eventId, query);
  }

  /**
   * 3.6: explicitly resend an UNCERTAIN email (the provider may have sent it,
   * so it is never resent automatically). Queues a new email log.
   */
  @Post(":eventId/email-logs/:emailLogId/resend")
  @EventScoped({ module: "emails", write: true })
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async resendLog(@Param() params: ResendEmailLogParamDto) {
    return this.send.resendUncertain(params.eventId, params.emailLogId);
  }

  // ==========================================================================
  // BULK SEND + CUSTOM SEND
  // ==========================================================================

  @Post(":eventId/email-templates/:templateId/send")
  @EventScoped({ module: "emails", write: true })
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async bulkSend(
    @Param() params: BulkSendParamDto,
    @Body() body: BulkSendEmailDto,
  ) {
    const event = await this.eventForSend(params.eventId);
    const template = await this.template(params.templateId);
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
  @EventScoped({ module: "emails", write: true })
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async sendCustom(
    @Param() params: SendCustomEmailParamDto,
    @Body() body: SendCustomEmailDto,
  ) {
    const event = await this.eventForSend(params.eventId);
    return this.send.sendCustom(
      event,
      params.registrationId,
      body.subject,
      body.content,
    );
  }
}
