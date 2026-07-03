import {
  Body,
  Controller,
  Delete,
  Get,
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
import { ErrorCodes, UserRole } from "@app/contracts";
import { getEventForRegistrationAdmin } from "@app/db";
import { getStorageProvider } from "@app/integrations";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { canAccessClient, assertEventWritable, type AuthUser } from "../events";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { AppException } from "../../core/app-exception";
import { RegistrationsService, extractKeyFromUrl } from "./registrations.service";
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

function forbidden(): never {
  throw new AppException(ErrorCodes.FORBIDDEN, "Insufficient permissions", 403);
}

@Controller("api/events")
@Auth()
export class RegistrationsController {
  constructor(private readonly service: RegistrationsService) {}

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
  async columns(
    @Param() { eventId }: EventIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.loadEvent(eventId, user);
    return this.service.getRegistrationTableColumns(eventId);
  }

  // GET /api/events/:eventId/registrants/search
  @Get(":eventId/registrants/search")
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
  async adminCreate(
    @Param() { eventId }: EventIdParamDto,
    @Body() body: AdminCreateRegistrationDto,
    @CurrentUser() user: AuthUser,
  ) {
    const event = await this.loadEvent(eventId, user);
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "registrations");
    await assertClientModuleEnabled(event.clientId, "pricing");
    return this.service.createAdminRegistration(eventId, body, user.id);
  }

  // PUT /api/events/:eventId/registrations/:id/admin-edit — requires admin role.
  @Put(":eventId/registrations/:id/admin-edit")
  @Auth(UserRole.CLIENT_ADMIN)
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
    return this.service.adminEditRegistration(eventId, id, body, user.id);
  }

  // GET /api/events/:eventId/registrations — list
  @Get(":eventId/registrations")
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
    return this.service.updateRegistration(id, body, user.id);
  }

  // DELETE /api/events/registrations/:id
  @Delete("registrations/:id")
  @HttpCode(204)
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
    await this.service.deleteRegistration(id, user.id, force, user.role);
  }

  // POST /api/events/registrations/:id/confirm — confirm payment (keeps editToken)
  @Post("registrations/:id/confirm")
  @HttpCode(200)
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
    return this.service.confirmPayment(id, body, user.id, ip);
  }

  // GET /api/events/registrations/:id/audit-logs
  @Get("registrations/:id/audit-logs")
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

  // GET /api/events/registrations/:id/payment-proof — 302 to a signed URL
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
    const key = extractKeyFromUrl(registration.paymentProofUrl);
    if (!key) {
      // Un-parseable legacy URL — redirect straight to the stored value.
      return reply.redirect(registration.paymentProofUrl, 302);
    }
    const signedUrl = await getStorageProvider().getSignedUrl(key, 3600);
    return reply.redirect(signedUrl, 302);
  }
}
