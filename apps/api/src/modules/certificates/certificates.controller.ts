import {
  BadRequestException,
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
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { assertEventAccess } from "../../core/auth/assert-event-access";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { assertEventWritable } from "../events/events.service";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";
import { CertificatesService } from "./certificates.service";
import {
  CertificateEventIdParamDto,
  CertificateIdParamDto,
  CreateCertificateTemplateDto,
  UpdateCertificateTemplateDto,
  SendCertificatesBodyDto,
} from "./certificates.dto";

// @fastify/multipart augments the request with .file(); minimal shape used here.
type MultipartFile = {
  filename: string;
  mimetype: string;
  toBuffer(): Promise<Buffer>;
};
type MultipartRequest = FastifyRequest & {
  file(options?: {
    limits?: { fileSize?: number };
  }): Promise<MultipartFile | undefined>;
};

/**
 * Admin certificate routes, mounted at /api/events. Every route requires a valid
 * token (@Auth); per-route ownership is enforced via canAccessClient against the
 * owning event's client, then the "certificates" module gate. Route-level 404/403
 * are plain (code derived by the global filter). NOTE: /certificates/:id is a
 * SIBLING of /:eventId/certificates (Fastify prioritises the static segment).
 */
@Auth()
@Controller("api/events")
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  // GET /api/events/:eventId/certificates — list templates for event
  @Get(":eventId/certificates")
  async list(
    @CurrentUser() user: AuthUser,
    @Param() params: CertificateEventIdParamDto,
  ) {
    const event = await assertEventAccess(user, params.eventId);
    await assertClientModuleEnabled(event.clientId, "certificates");

    return this.certificates.listTemplates(params.eventId);
  }

  // POST /api/events/:eventId/certificates — create template (JSON only)
  @Post(":eventId/certificates")
  @HttpCode(201)
  async create(
    @CurrentUser() user: AuthUser,
    @Param() params: CertificateEventIdParamDto,
    @Body() body: CreateCertificateTemplateDto,
  ) {
    const event = await assertEventAccess(user, params.eventId);
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "certificates");

    return this.certificates.createTemplate(params.eventId, body);
  }

  // GET /api/events/certificates/:id — get single template
  @Get("certificates/:id")
  async getOne(
    @CurrentUser() user: AuthUser,
    @Param() params: CertificateIdParamDto,
  ) {
    const template = await this.certificates.getTemplate(params.id);
    if (!canAccessClient(user, template.event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    await assertClientModuleEnabled(template.event.clientId, "certificates");

    return template;
  }

  // PATCH /api/events/certificates/:id — update template
  @Patch("certificates/:id")
  async update(
    @CurrentUser() user: AuthUser,
    @Param() params: CertificateIdParamDto,
    @Body() body: UpdateCertificateTemplateDto,
  ) {
    const existing = await this.certificates.getTemplate(params.id);
    if (!canAccessClient(user, existing.event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    assertEventWritable(existing.event);
    await assertClientModuleEnabled(existing.event.clientId, "certificates");

    return this.certificates.updateTemplate(params.id, body);
  }

  // DELETE /api/events/certificates/:id — delete template + stored image
  @Delete("certificates/:id")
  @HttpCode(204)
  @SkipEnvelope() // bare 204, no body/envelope (legacy parity)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param() params: CertificateIdParamDto,
  ) {
    const existing = await this.certificates.getTemplate(params.id);
    if (!canAccessClient(user, existing.event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    assertEventWritable(existing.event);
    await assertClientModuleEnabled(existing.event.clientId, "certificates");

    await this.certificates.deleteTemplate(params.id);
  }

  // POST /api/events/certificates/:id/image — upload template image (multipart)
  @Post("certificates/:id/image")
  @HttpCode(200)
  async uploadImage(
    @CurrentUser() user: AuthUser,
    @Param() params: CertificateIdParamDto,
    @Req() req: MultipartRequest,
  ) {
    const existing = await this.certificates.getTemplate(params.id);
    if (!canAccessClient(user, existing.event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    assertEventWritable(existing.event);
    await assertClientModuleEnabled(existing.event.clientId, "certificates");

    const data = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB
    if (!data) {
      throw new BadRequestException("No file uploaded");
    }

    const buffer = await data.toBuffer();
    return this.certificates.uploadTemplateImage(params.id, {
      buffer,
      filename: data.filename,
      mimetype: data.mimetype,
    });
  }

  // GET /api/events/certificates/:id/image — download/proxy template image
  @Get("certificates/:id/image")
  @SkipEnvelope() // streaming proxy: raw image bytes, no envelope
  async downloadImage(
    @CurrentUser() user: AuthUser,
    @Param() params: CertificateIdParamDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const existing = await this.certificates.getTemplate(params.id);
    if (!canAccessClient(user, existing.event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    await assertClientModuleEnabled(existing.event.clientId, "certificates");

    if (!existing.templateUrl) {
      throw new NotFoundException("Certificate template image not found");
    }

    const file = await this.certificates.downloadTemplateImage(
      existing.templateUrl,
    );

    void reply
      .header("Cache-Control", "private, max-age=300")
      .type(file.contentType ?? "application/octet-stream")
      .send(file.buffer);
  }

  // POST /api/events/:eventId/certificates/send — bulk-send certificates via email
  @Post(":eventId/certificates/send")
  @HttpCode(200)
  async send(
    @CurrentUser() user: AuthUser,
    @Param() params: CertificateEventIdParamDto,
    @Body() body: SendCertificatesBodyDto,
  ) {
    const event = await assertEventAccess(user, params.eventId);
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "certificates");
    await assertClientModuleEnabled(event.clientId, "emails");

    return this.certificates.sendCertificates(
      { id: event.id, clientId: event.clientId },
      body.registrationIds,
    );
  }
}
