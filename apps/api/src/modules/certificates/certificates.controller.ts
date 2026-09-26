import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import type { ScopedEventRow } from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { CertificateTemplateScoped, EventScoped, ScopedEvent } from "../tenancy";
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
 * token (@Auth) and declares its tenant scope (event or certificate template →
 * event → client, "certificates" module; writes refuse an archived event).
 * NOTE: /certificates/:id is a SIBLING of /:eventId/certificates (Fastify
 * prioritises the static segment).
 */
@Auth()
@Controller("api/events")
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  // GET /api/events/:eventId/certificates — list templates for event
  @Get(":eventId/certificates")
  @EventScoped({ module: "certificates" })
  async list(@Param() params: CertificateEventIdParamDto) {
    return this.certificates.listTemplates(params.eventId);
  }

  // POST /api/events/:eventId/certificates — create template (JSON only)
  @Post(":eventId/certificates")
  @HttpCode(201)
  @EventScoped({ module: "certificates", write: true })
  async create(
    @Param() params: CertificateEventIdParamDto,
    @Body() body: CreateCertificateTemplateDto,
  ) {
    return this.certificates.createTemplate(params.eventId, body);
  }

  // GET /api/events/certificates/:id — get single template
  @Get("certificates/:id")
  @CertificateTemplateScoped({ module: "certificates" })
  async getOne(@Param() params: CertificateIdParamDto) {
    return this.certificates.getTemplate(params.id);
  }

  // PATCH /api/events/certificates/:id — update template
  @Patch("certificates/:id")
  @CertificateTemplateScoped({ module: "certificates", write: true })
  async update(
    @Param() params: CertificateIdParamDto,
    @Body() body: UpdateCertificateTemplateDto,
  ) {
    return this.certificates.updateTemplate(params.id, body);
  }

  // DELETE /api/events/certificates/:id — delete template + stored image
  @Delete("certificates/:id")
  @HttpCode(204)
  @SkipEnvelope() // bare 204, no body/envelope (legacy parity)
  @CertificateTemplateScoped({ module: "certificates", write: true })
  async remove(@Param() params: CertificateIdParamDto) {
    await this.certificates.deleteTemplate(params.id);
  }

  // POST /api/events/certificates/:id/image — upload template image (multipart)
  @Post("certificates/:id/image")
  @HttpCode(200)
  @CertificateTemplateScoped({ module: "certificates", write: true })
  async uploadImage(
    @Param() params: CertificateIdParamDto,
    @Req() req: MultipartRequest,
  ) {
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
  @CertificateTemplateScoped({ module: "certificates" })
  async downloadImage(
    @Param() params: CertificateIdParamDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const existing = await this.certificates.getTemplate(params.id);
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

  // POST /api/events/:eventId/certificates/send — bulk-send certificates via
  // email. `registrationIds` (undefined = all, [] = none) targets attendee
  // certs as before; `abstractIds` (H2) additionally sends presenter
  // certificates for eligible abstracts (ACCEPTED + presentedAt != null) to
  // their author — omit it to leave abstract behavior untouched.
  @Post(":eventId/certificates/send")
  @HttpCode(200)
  @EventScoped({ module: ["certificates", "emails"], write: true })
  async send(
    @Param() _params: CertificateEventIdParamDto,
    @Body() body: SendCertificatesBodyDto,
    @ScopedEvent() event: ScopedEventRow,
  ) {
    return this.certificates.sendCertificates(
      { id: event.id, clientId: event.clientId },
      body.registrationIds,
      body.abstractIds,
    );
  }
}
