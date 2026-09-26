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
import { getEventForRegistrationAdmin } from "@app/db";
import {
  getStorageProvider,
  extractStorageKeyFromUrl,
  StorageObjectNotFoundError,
} from "@app/integrations";
import { Auth, RequireRole } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { ResponseContract } from "../../core/response-contract";
import { assertEventWritable } from "../events";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { AppException, forbidden } from "../../core/app-exception";
import { RegistrationsService } from "./registrations.service";
import { RegistrationCreateService } from "./registrations.create.service";
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
    private readonly creator: RegistrationCreateService,
    private readonly repricer: RegistrationRepricer,
    private readonly payments: RegistrationPaymentsService,
  ) {}

  private async loadEvent(eventId: string, user: AuthUser) {
    const event = await getEventForRegistrationAdmin(eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    if (!canAccessClient(user, event.clientId)) forbidden();
    return event;
  }

  // GET /api/events/:eventId/registrations/columns
  @Get(":eventId/registrations/columns")
  @ResponseContract(RegistrationTableColumnsResponseSchema)
  async columns(
    @Param() { eventId }: EventIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.loadEvent(eventId, user);
    return this.service.getRegistrationTableColumns(eventId);
  }

  // GET /api/events/:eventId/registrants/search
  @Get(":eventId/registrants/search")
  @ResponseContract(AdminRegistrantSearchResponseSchema)
  async search(
    @Param() { eventId }: EventIdParamDto,
    @Query() query: SearchRegistrantsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.loadEvent(eventId, user);
    return this.service.searchRegistrantsForSponsorship(eventId, query);
  }

  // POST /api/events/:eventId/admin/registrations
  @Post(":eventId/admin/registrations")
  @HttpCode(201)
  @ResponseContract(AdminRegistrationResponseSchema)
  async adminCreate(
    @Param() { eventId }: EventIdParamDto,
    @Body() body: AdminCreateRegistrationDto,
    @CurrentUser() user: AuthUser,
  ) {
    const event = await this.loadEvent(eventId, user);
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "registrations");
    await assertClientModuleEnabled(event.clientId, "pricing");
    return this.creator.createAdminRegistration(eventId, body, user.id);
  }

  // PUT /api/events/:eventId/registrations/:id/admin-edit — requires admin role.
  @Put(":eventId/registrations/:id/admin-edit")
  @RequireRole(UserRole.CLIENT_ADMIN)
  @ResponseContract(AdminRegistrationResponseSchema)
  async adminEdit(
    @Param() { eventId, id }: EventRegistrationIdParamDto,
    @Body() body: AdminEditRegistrationDto,
    @CurrentUser() user: AuthUser,
  ) {
    const event = await this.loadEvent(eventId, user);
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "registrations");
    if (body.accessSelections !== undefined) {
      await assertClientModuleEnabled(event.clientId, "pricing");
    }
    return this.repricer.adminEditRegistration(eventId, id, body, user.id);
  }

  // GET /api/events/:eventId/registrations — list
  @Get(":eventId/registrations")
  @ResponseContract(AdminRegistrationListResponseSchema)
  async list(
    @Param() { eventId }: EventIdParamDto,
    @Query() query: ListRegistrationsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.loadEvent(eventId, user);
    return this.service.listRegistrations(eventId, query);
  }

  // GET /api/events/registrations/:id
  @Get("registrations/:id")
  @ResponseContract(AdminRegistrationResponseSchema)
  async getById(
    @Param() { id }: RegistrationIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    const registration = await this.service.getRegistrationById(id);
    if (!registration) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    if (!canAccessClient(user, registration.event.clientId)) forbidden();
    return registration;
  }

  // PATCH /api/events/registrations/:id — admin partial update
  @Patch("registrations/:id")
  @ResponseContract(AdminRegistrationResponseSchema)
  async update(
    @Param() { id }: RegistrationIdParamDto,
    @Body() body: UpdateRegistrationDto,
    @CurrentUser() user: AuthUser,
  ) {
    const clientId = await this.service.getRegistrationClientId(id);
    if (clientId === null) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    if (!canAccessClient(user, clientId)) forbidden();
    await assertClientModuleEnabled(clientId, "registrations");
    return this.payments.updateRegistration(id, body, user.id);
  }

  // DELETE /api/events/registrations/:id
  @Delete("registrations/:id")
  @HttpCode(204)
  @SkipEnvelope()
  async remove(
    @Param() { id }: RegistrationIdParamDto,
    @Query() { force }: DeleteRegistrationQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const clientId = await this.service.getRegistrationClientId(id);
    if (clientId === null) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    if (!canAccessClient(user, clientId)) forbidden();
    await assertClientModuleEnabled(clientId, "registrations");
    await this.service.deleteRegistration(id, user.id, force);
  }

  // POST /api/events/registrations/:id/confirm — confirm payment
  @Post("registrations/:id/confirm")
  @HttpCode(200)
  @ResponseContract(AdminRegistrationResponseSchema)
  async confirm(
    @Param() { id }: RegistrationIdParamDto,
    @Body() body: UpdatePaymentDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    const clientId = await this.service.getRegistrationClientId(id);
    if (clientId === null) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Registration not found", 404);
    }
    if (!canAccessClient(user, clientId)) forbidden();
    await assertClientModuleEnabled(clientId, "registrations");
    return this.payments.confirmPayment(id, body, user.id, ip);
  }

  // GET /api/events/registrations/:id/audit-logs
  @Get("registrations/:id/audit-logs")
  @ResponseContract(RegistrationAuditLogListResponseSchema)
  async auditLogs(
    @Param() { id }: RegistrationIdParamDto,
    @Query() query: ListRegistrationAuditLogsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const clientId = await this.service.getRegistrationClientId(id);
    if (clientId === null) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Registration not found", 404);
    }
    if (!canAccessClient(user, clientId)) forbidden();
    return this.service.listRegistrationAuditLogs(id, query);
  }

  // GET /api/events/registrations/:id/email-logs
  @Get("registrations/:id/email-logs")
  @ResponseContract(RegistrationEmailLogListResponseSchema)
  async emailLogs(
    @Param() { id }: RegistrationIdParamDto,
    @Query() query: ListRegistrationEmailLogsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const clientId = await this.service.getRegistrationClientId(id);
    if (clientId === null) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Registration not found", 404);
    }
    if (!canAccessClient(user, clientId)) forbidden();
    return this.service.listRegistrationEmailLogs(id, query);
  }

  // GET /api/events/registrations/:id/payment-proof — proxy the file bytes.
  // A 302 to the signed storage URL made the admin's cross-origin
  // fetch().blob() depend on bucket CORS config; stream through the API
  // instead, like certificates/:id/image does.
  @Get("registrations/:id/payment-proof")
  @SkipEnvelope()
  async paymentProof(
    @Param() { id }: RegistrationIdParamDto,
    @CurrentUser() user: AuthUser,
    @Res() reply: FastifyReply,
  ) {
    const registration = await this.service.getRegistrationById(id);
    if (!registration) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Registration not found", 404);
    }
    if (!canAccessClient(user, registration.event.clientId)) forbidden();
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
  @Header("Cache-Control", "no-store")
  @ResponseContract(RegistrationEditLinkResponseSchema)
  async editLink(
    @Param() { id }: RegistrationIdParamDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    const clientId = await this.service.getRegistrationClientId(id);
    if (clientId === null) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Registration not found", 404);
    }
    if (!canAccessClient(user, clientId)) forbidden();
    return this.service.issueSelfEditLink(id, user.id, ip);
  }
}
