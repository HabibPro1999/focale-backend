import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { BadgeTemplateListResponseSchema, BadgeTemplateResponseSchema } from "@app/contracts";
import { getAvailableVariables, type VariableDefinition } from "@app/integrations";
import { Auth } from "../../core/auth/auth.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { readSingleFile, type MultipartRequest } from "../../core/multipart";
import { ResponseContract } from "../../core/response-contract";
import { BadgeTemplateScoped, EventScoped, RegistrationScoped } from "../tenancy";
import { BadgesService, type BadgePdf } from "./badges.service";
import {
  BadgeEventIdParamDto,
  BadgeIdParamDto,
  BadgeRegistrationIdParamDto,
  BadgeVariablesQueryDto,
  CreateBadgeTemplateDto,
  RegistrationBadgeQueryDto,
  UpdateBadgeTemplateDto,
} from "./badges.dto";

/** A rendered badge as raw PDF bytes (no envelope), never cached: it carries registrant data. */
function sendPdf(reply: FastifyReply, { pdf, filename }: BadgePdf): void {
  void reply
    .header("Cache-Control", "private, no-store")
    .header("Content-Disposition", `inline; filename="${filename}"`)
    .type("application/pdf")
    .send(pdf);
}

/**
 * Admin badge routes, mounted at /api/events. Every route requires a valid
 * token (@Auth) and is gated by the registrations module; writes refuse an
 * archived event. /badges/:id is a SIBLING of /:eventId/badges (Fastify
 * prioritises the static segment), as for certificates.
 */
@Auth()
@Controller("api/events")
export class BadgesController {
  constructor(private readonly badges: BadgesService) {}

  @Get(":eventId/badges")
  @EventScoped({ module: "registrations" })
  @ResponseContract(BadgeTemplateListResponseSchema)
  list(@Param() params: BadgeEventIdParamDto) {
    return this.badges.list(params.eventId);
  }

  // The email variable catalogue (text zones read the email context), behind
  // the registrations module: the same payload as
  // GET :eventId/email-templates/variables, which needs the emails module.
  @Get(":eventId/badges/variables")
  @EventScoped({ module: "registrations" })
  variables(
    @Param() params: BadgeEventIdParamDto,
    @Query() query: BadgeVariablesQueryDto,
  ): Promise<VariableDefinition[]> {
    return getAvailableVariables(params.eventId, query.language);
  }

  @Post(":eventId/badges")
  @HttpCode(201)
  @EventScoped({ module: "registrations", write: true })
  @ResponseContract(BadgeTemplateResponseSchema)
  create(@Param() params: BadgeEventIdParamDto, @Body() body: CreateBadgeTemplateDto) {
    return this.badges.create(params.eventId, body);
  }

  @Get("badges/:id")
  @BadgeTemplateScoped({ module: "registrations" })
  @ResponseContract(BadgeTemplateResponseSchema)
  getOne(@Param() params: BadgeIdParamDto) {
    return this.badges.get(params.id);
  }

  @Patch("badges/:id")
  @BadgeTemplateScoped({ module: "registrations", write: true })
  @ResponseContract(BadgeTemplateResponseSchema)
  update(@Param() params: BadgeIdParamDto, @Body() body: UpdateBadgeTemplateDto) {
    return this.badges.update(params.id, body);
  }

  // Soft delete: bare 204.
  @Delete("badges/:id")
  @HttpCode(204)
  @SkipEnvelope()
  @BadgeTemplateScoped({ module: "registrations", write: true })
  async remove(@Param() params: BadgeIdParamDto) {
    await this.badges.delete(params.id);
  }

  // Multipart PNG or JPEG, at most 10 MB and 20 megapixels.
  @Post("badges/:id/background")
  @HttpCode(200)
  @BadgeTemplateScoped({ module: "registrations", write: true })
  @ResponseContract(BadgeTemplateResponseSchema)
  async uploadBackground(@Param() params: BadgeIdParamDto, @Req() req: MultipartRequest) {
    const file = await readSingleFile(req, {
      fileSize: 10 * 1024 * 1024,
      missingFile: () => new BadRequestException("No file uploaded"),
    });
    return this.badges.uploadBackground(params.id, file);
  }

  @Delete("badges/:id/background")
  @HttpCode(200)
  @BadgeTemplateScoped({ module: "registrations", write: true })
  @ResponseContract(BadgeTemplateResponseSchema)
  removeBackground(@Param() params: BadgeIdParamDto) {
    return this.badges.removeBackground(params.id);
  }

  // Image proxy for the admin canvas: raw bytes, no envelope.
  @Get("badges/:id/background")
  @SkipEnvelope()
  @BadgeTemplateScoped({ module: "registrations" })
  async downloadBackground(@Param() params: BadgeIdParamDto, @Res() reply: FastifyReply): Promise<void> {
    const file = await this.badges.downloadBackground(params.id);
    void reply
      .header("Cache-Control", "private, max-age=300")
      .type(file.contentType ?? "application/octet-stream")
      .send(file.buffer);
  }

  // The exact server render with the sample values and the sample registration's QR.
  @Get("badges/:id/sample.pdf")
  @SkipEnvelope()
  @BadgeTemplateScoped({ module: "registrations" })
  async samplePdf(@Param() params: BadgeIdParamDto, @Res() reply: FastifyReply): Promise<void> {
    sendPdf(reply, await this.badges.samplePdf(params.id));
  }

  // A registrant's badge, for print and download; the badge must be of the registration's event.
  @Get("registrations/:registrationId/badge.pdf")
  @SkipEnvelope()
  @RegistrationScoped({ module: "registrations", param: "registrationId" })
  async registrationPdf(
    @Param() params: BadgeRegistrationIdParamDto,
    @Query() query: RegistrationBadgeQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    sendPdf(reply, await this.badges.registrationPdf(params.registrationId, query.badgeId));
  }
}
