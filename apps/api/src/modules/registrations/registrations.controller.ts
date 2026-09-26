import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Ip,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import {
  AdminRegistrantSearchResponseSchema,
  AdminRegistrationListResponseSchema,
  AdminRegistrationResponseSchema,
  ErrorCodes,
  RegistrationAuditLogListResponseSchema,
  RegistrationEditLinkResponseSchema,
  RegistrationEmailLogListResponseSchema,
  RegistrationTableColumnsResponseSchema,
  UserRole,
} from "@app/contracts";
import type { ScopedClientRow } from "@app/db";
import {
  getStorageProvider,
  extractStorageKeyFromUrl,
  StorageObjectNotFoundError,
} from "@app/integrations";
import { Auth, RequireRole } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { ResponseContract } from "../../core/response-contract";
import { type AuthUser } from "../../core/auth/user-cache";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { AppException } from "../../core/app-exception";
import { EventScoped, RegistrationScoped, ScopedClient } from "../tenancy";
import { RegistrationsService } from "./registrations.service";
import { RegistrationRepricer } from "./registrations.repricer";
import { RegistrationPaymentsService } from "./registrations.payments.service";
import {
  AdminCreateRegistrationDto,
  AdminEditRegistrationDto,
  DeleteRegistrationQueryDto,
  EventIdParamDto,
  EventRegistrationIdParamDto,
  ListRegistrationsQueryDto,
  ListRegistrationAuditLogsQueryDto,
  ListRegistrationEmailLogsQueryDto,
  RegistrationIdParamDto,
  SearchRegistrantsQueryDto,
  UpdatePaymentDto,
  UpdateRegistrationDto,
} from "./registrations.dto";

@Controller("api/events")
@Auth()
export class RegistrationsController {
  constructor(
    private readonly service: RegistrationsService,
    private readonly repricer: RegistrationRepricer,
    private readonly payments: RegistrationPaymentsService,
  ) {}

  // GET /api/events/:eventId/registrations/columns
  @Get(":eventId/registrations/columns")
  @EventScoped()
  @ResponseContract(RegistrationTableColumnsResponseSchema)
  async columns(@Param() { eventId }: EventIdParamDto) {
    return this.service.getRegistrationTableColumns(eventId);
  }

  // GET /api/events/:eventId/registrants/search
  @Get(":eventId/registrants/search")
  @EventScoped()
  @ResponseContract(AdminRegistrantSearchResponseSchema)
  async search(
    @Param() { eventId }: EventIdParamDto,
    @Query() query: SearchRegistrantsQueryDto,
  ) {
    return this.service.searchRegistrantsForSponsorship(eventId, query);
  }

  // POST /api/events/:eventId/admin/registrations
  @Post(":eventId/admin/registrations")
  @EventScoped({ module: ["registrations", "pricing"], write: true })
  @HttpCode(201)
  @ResponseContract(AdminRegistrationResponseSchema)
  async adminCreate(
    @Param() { eventId }: EventIdParamDto,
    @Body() body: AdminCreateRegistrationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.createAdminRegistration(eventId, body, user.id);
  }

  // PUT /api/events/:eventId/registrations/:id/admin-edit — requires admin role.
  @Put(":eventId/registrations/:id/admin-edit")
  @RequireRole(UserRole.CLIENT_ADMIN)
  @EventScoped({ module: "registrations", write: true })
  @ResponseContract(AdminRegistrationResponseSchema)
  async adminEdit(
    @Param() { eventId, id }: EventRegistrationIdParamDto,
    @Body() body: AdminEditRegistrationDto,
    @CurrentUser() user: AuthUser,
    @ScopedClient() client: ScopedClientRow,
  ) {
    if (body.accessSelections !== undefined) {
      assertModuleEnabledForClient(client, "pricing");
    }
    return this.repricer.adminEditRegistration(eventId, id, body, user.id);
  }

  // GET /api/events/:eventId/registrations — list
  @Get(":eventId/registrations")
  @EventScoped()
  @ResponseContract(AdminRegistrationListResponseSchema)
  async list(
    @Param() { eventId }: EventIdParamDto,
    @Query() query: ListRegistrationsQueryDto,
  ) {
    return this.service.listRegistrations(eventId, query);
  }

  // GET /api/events/registrations/:id
  @Get("registrations/:id")
  @RegistrationScoped()
  @ResponseContract(AdminRegistrationResponseSchema)
  async getById(@Param() { id }: RegistrationIdParamDto) {
    const registration = await this.service.getRegistrationById(id);
    if (!registration) registrationNotFound();
    return registration;
  }

  // PATCH /api/events/registrations/:id — admin partial update
  @Patch("registrations/:id")
  @RegistrationScoped({ module: "registrations" })
  @ResponseContract(AdminRegistrationResponseSchema)
  async update(
    @Param() { id }: RegistrationIdParamDto,
    @Body() body: UpdateRegistrationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payments.updateRegistration(id, body, user.id);
  }

  // DELETE /api/events/registrations/:id
  @Delete("registrations/:id")
  @RegistrationScoped({ module: "registrations" })
  @HttpCode(204)
  @SkipEnvelope()
  async remove(
    @Param() { id }: RegistrationIdParamDto,
    @Query() { force }: DeleteRegistrationQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.deleteRegistration(id, user.id, force);
  }

  // POST /api/events/registrations/:id/confirm — confirm payment
  @Post("registrations/:id/confirm")
  @RegistrationScoped({ module: "registrations" })
  @HttpCode(200)
  @ResponseContract(AdminRegistrationResponseSchema)
  async confirm(
    @Param() { id }: RegistrationIdParamDto,
    @Body() body: UpdatePaymentDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    return this.payments.confirmPayment(id, body, user.id, ip);
  }

  // GET /api/events/registrations/:id/audit-logs
  @Get("registrations/:id/audit-logs")
  @RegistrationScoped()
  @ResponseContract(RegistrationAuditLogListResponseSchema)
  async auditLogs(
    @Param() { id }: RegistrationIdParamDto,
    @Query() query: ListRegistrationAuditLogsQueryDto,
  ) {
    return this.service.listRegistrationAuditLogs(id, query);
  }

  // GET /api/events/registrations/:id/email-logs
  @Get("registrations/:id/email-logs")
  @RegistrationScoped()
  @ResponseContract(RegistrationEmailLogListResponseSchema)
  async emailLogs(
    @Param() { id }: RegistrationIdParamDto,
    @Query() query: ListRegistrationEmailLogsQueryDto,
  ) {
    return this.service.listRegistrationEmailLogs(id, query);
  }

  // GET /api/events/registrations/:id/payment-proof — proxy the file bytes.
  // A 302 to the signed storage URL made the admin's cross-origin
  // fetch().blob() depend on bucket CORS config; stream through the API
  // instead, like certificates/:id/image does.
  @Get("registrations/:id/payment-proof")
  @RegistrationScoped()
  @SkipEnvelope()
  async paymentProof(
    @Param() { id }: RegistrationIdParamDto,
    @Res() reply: FastifyReply,
  ) {
    const registration = await this.service.getRegistrationById(id);
    if (!registration) registrationNotFound();
    if (!registration.paymentProofUrl) {
      throw new AppException(ErrorCodes.NOT_FOUND, "No payment proof uploaded", 404);
    }
    const key = extractStorageKeyFromUrl(registration.paymentProofUrl);
    if (!key) {
      // Un-parseable legacy URL — redirect straight to the stored value.
      return reply.redirect(registration.paymentProofUrl, 302);
    }
    let file;
    try {
      file = await getStorageProvider().download(key);
    } catch (err: unknown) {
      if (err instanceof StorageObjectNotFoundError) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          "Payment proof not found in storage",
          404,
        );
      }
      throw err;
    }
    return reply
      .header("Cache-Control", "private, max-age=300")
      .type(file.contentType ?? "application/octet-stream")
      .send(file.buffer);
  }
}

// ============================================================================
// Registration-scoped admin routes — /api/registrations/:id/...
// ============================================================================

@Controller("api/registrations")
@Auth()
export class RegistrationEditLinkController {
  constructor(private readonly service: RegistrationsService) {}

  // GET /api/registrations/:id/edit-link — the registrant's self-edit link.
  // Same auth + tenant scoping as GET /api/events/registrations/:id (404 when
  // missing, 403 for another tenant). Every issuance is audited.
  @Get(":id/edit-link")
  @RegistrationScoped()
  @Header("Cache-Control", "no-store")
  @ResponseContract(RegistrationEditLinkResponseSchema)
  async editLink(
    @Param() { id }: RegistrationIdParamDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    return this.service.issueSelfEditLink(id, user.id, ip);
  }
}

/** The registration vanished between the scope guard and the read. */
function registrationNotFound(): never {
  throw new AppException(ErrorCodes.REGISTRATION_NOT_FOUND, "Registration not found", 404);
}
