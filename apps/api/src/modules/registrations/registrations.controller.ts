import { assertOwned } from "../../core/tenancy/ownership";
import { Body, Controller, Delete, Get, Header, HttpCode, Ip, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { UserRole } from "@app/contracts";
import { getEventForRegistrationAdmin } from "@app/db";
import { getStorageProvider, extractStorageKeyFromUrl } from "@app/integrations";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { assertEventWritable } from "../../core/tenancy/event-status";
import type { AuthUser } from "../../core/auth/user-cache";
import { assertClientModuleEnabled } from "../../core/tenancy/module-gates";
import { notFound } from "../../core/app-exception";
import { RegistrationsReadService } from "./registrations.read.service";
import { RegistrationsCreateService } from "./registrations.create.service";
import { RegistrationsAdminService } from "./registrations.admin.service";
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

async function requireRegistrationClientId(service: RegistrationsReadService, id: string, user: AuthUser) {
  const owner = await assertOwned(user, async () => {
    const clientId = await service.getRegistrationClientId(id);
    // Preserve this lookup's exact null check (an empty string is not missing).
    return clientId === null ? null : { clientId };
  }, (owner) => owner.clientId, { notFound: "Registration not found" });
  return owner.clientId;
}

@Controller("api/events")
@Auth()
export class RegistrationsController {
  constructor(
    private readonly read: RegistrationsReadService,
    private readonly create: RegistrationsCreateService,
    private readonly admin: RegistrationsAdminService,
  ) {}

  private async loadEvent(eventId: string, user: AuthUser) {
    return assertOwned(user, () => getEventForRegistrationAdmin(eventId), (event) => event.clientId, {
      notFound: "Event not found",
    });
  }

  // GET /api/events/:eventId/registrations/columns
  @Get(":eventId/registrations/columns")
  async columns(
    @Param() { eventId }: EventIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.loadEvent(eventId, user);
    return this.read.getRegistrationTableColumns(eventId);
  }

  // GET /api/events/:eventId/registrants/search
  @Get(":eventId/registrants/search")
  async search(
    @Param() { eventId }: EventIdParamDto,
    @Query() query: SearchRegistrantsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.loadEvent(eventId, user);
    return this.read.searchRegistrantsForSponsorship(eventId, query);
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
    return this.create.createAdminRegistration(eventId, body, user.id);
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
    return this.admin.adminEditRegistration(eventId, id, body, user.id);
  }

  // GET /api/events/:eventId/registrations — list
  @Get(":eventId/registrations")
  async list(
    @Param() { eventId }: EventIdParamDto,
    @Query() query: ListRegistrationsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.loadEvent(eventId, user);
    return this.read.listRegistrations(eventId, query);
  }

  // GET /api/events/registrations/:id
  @Get("registrations/:id")
  async getById(
    @Param() { id }: RegistrationIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    const registration = await assertOwned(user, () => this.read.getRegistrationById(id), (registration) => registration.event.clientId, {
      notFound: "Registration not found",
    });
    return registration;
  }

  // PATCH /api/events/registrations/:id — admin partial update
  @Patch("registrations/:id")
  async update(
    @Param() { id }: RegistrationIdParamDto,
    @Body() body: UpdateRegistrationDto,
    @CurrentUser() user: AuthUser,
  ) {
    const clientId = await requireRegistrationClientId(this.read, id, user);
    await assertClientModuleEnabled(clientId, "registrations");
    return this.admin.updateRegistration(id, body, user.id);
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
    const clientId = await requireRegistrationClientId(this.read, id, user);
    await assertClientModuleEnabled(clientId, "registrations");
    await this.admin.deleteRegistration(id, user.id, force, user.role);
  }

  // POST /api/events/registrations/:id/confirm — confirm payment
  @Post("registrations/:id/confirm")
  @HttpCode(200)
  async confirm(
    @Param() { id }: RegistrationIdParamDto,
    @Body() body: UpdatePaymentDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    const clientId = await requireRegistrationClientId(this.read, id, user);
    await assertClientModuleEnabled(clientId, "registrations");
    return this.admin.confirmPayment(id, body, user.id, ip);
  }

  // GET /api/events/registrations/:id/audit-logs
  @Get("registrations/:id/audit-logs")
  async auditLogs(
    @Param() { id }: RegistrationIdParamDto,
    @Query() query: ListRegistrationAuditLogsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const clientId = await requireRegistrationClientId(this.read, id, user);
    return this.read.listRegistrationAuditLogs(id, query);
  }

  // GET /api/events/registrations/:id/email-logs
  @Get("registrations/:id/email-logs")
  async emailLogs(
    @Param() { id }: RegistrationIdParamDto,
    @Query() query: ListRegistrationEmailLogsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const clientId = await requireRegistrationClientId(this.read, id, user);
    return this.read.listRegistrationEmailLogs(id, query);
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
    const registration = await assertOwned(user, () => this.read.getRegistrationById(id), (registration) => registration.event.clientId, {
      notFound: "Registration not found",
    });
    if (!registration.paymentProofUrl) {
      throw notFound("No payment proof uploaded");
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
      if ((err as { code?: number }).code === 404) {
        throw notFound("Payment proof not found in storage");
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
  constructor(private readonly read: RegistrationsReadService) {}

  // GET /api/registrations/:id/edit-link — the registrant's self-edit link.
  // Same auth + tenant scoping as GET /api/events/registrations/:id (404 when
  // missing, 403 for another tenant). Every issuance is audited.
  @Get(":id/edit-link")
  @Header("Cache-Control", "no-store")
  async editLink(
    @Param() { id }: RegistrationIdParamDto,
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
  ) {
    const clientId = await requireRegistrationClientId(this.read, id, user);
    return this.read.issueSelfEditLink(id, user.id, ip);
  }
}
