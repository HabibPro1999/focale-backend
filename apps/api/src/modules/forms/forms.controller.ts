import { assertOwned } from "../../core/tenancy/ownership";
import { notFound, badRequest } from "../../core/app-exception";
import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ErrorCodes, UserRole } from "@app/contracts";
import {
  getEventWithPricing,
  type ClientRow,
  type Form,
  type FormWithEvent,
} from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import type { AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { assertClientModuleEnabled } from "../../core/tenancy/module-gates";
import { assertEventWritable } from "../../core/tenancy/event-status";
import { FormsService } from "./forms.service";
import type { PaginatedResult } from "@app/shared";
import {
  CreateFormDto,
  UpdateFormDto,
  ListFormsQueryDto,
  FormIdParamDto,
  UpdateSponsorshipSettingsDto,
  CreateSponsorFormBodyDto,
  EventIdParamDto,
} from "./dto";

/** Request after AuthGuard: 8-field user + resolved client attached. */
type AuthedRequest = FastifyRequest & {
  user: AuthUser;
  client: ClientRow | null;
};

// requireAdmin: @Auth(CLIENT_ADMIN) = role <= 1 (super_admin or client_admin).
@Controller("api/forms")
@Auth(UserRole.CLIENT_ADMIN)
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: CreateFormDto,
    @Req() req: AuthedRequest,
  ): Promise<Form> {
    const event = await this.requireOwnedEvent(body.eventId, req.user, "Insufficient permissions to create form for this event");
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "registrations");
    return this.forms.createForm(body);
  }

  @Get()
  async list(
    @Query() query: ListFormsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<PaginatedResult<Form>> {
    if (req.user.role === UserRole.CLIENT_ADMIN) {
      if (!req.user.clientId) {
        throw badRequest("User is not associated with any client");
      }
      if (!query.eventId) {
        throw badRequest("Event ID is required for client admin users");
      }
    } else if (req.user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: "Insufficient permissions",
      });
    }

    if (query.eventId) {
      const event = await this.requireOwnedEvent(query.eventId, req.user, "Insufficient permissions to access this event");
      if (query.type === "SPONSOR") {
        await assertClientModuleEnabled(event.clientId, "sponsorships");
      } else if (query.type === "REGISTRATION") {
        await assertClientModuleEnabled(event.clientId, "registrations");
      } else {
        await assertClientModuleEnabled(event.clientId, "registrations");
        await assertClientModuleEnabled(event.clientId, "sponsorships");
      }
    }

    return this.forms.listForms(query);
  }

  @Get("events/:id/sponsor")
  async getSponsorByEvent(
    @Param() params: EventIdParamDto,
    @Req() req: AuthedRequest,
  ): Promise<Form> {
    const event = await this.requireOwnedEvent(params.id, req.user, "Insufficient permissions to access this event");
    await assertClientModuleEnabled(event.clientId, "sponsorships");

    const form = await this.forms.getSponsorFormByEventId(params.id);
    if (!form) {
      throw notFound("Sponsor form not found for this event");
    }
    return form;
  }

  @Post("events/:id/sponsor")
  @HttpCode(201)
  async createSponsorByEvent(
    @Param() params: EventIdParamDto,
    @Body() body: CreateSponsorFormBodyDto,
    @Req() req: AuthedRequest,
  ): Promise<Form> {
    const event = await this.requireOwnedEvent(params.id, req.user, "Insufficient permissions to create form for this event");
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "sponsorships");
    return this.forms.createSponsorForm(params.id, body?.name);
  }

  @Get(":id")
  async getOne(
    @Param() params: FormIdParamDto,
    @Req() req: AuthedRequest,
  ): Promise<FormWithEvent> {
    const form = await this.requireOwnedForm(params.id, req.user, "access");
    await assertClientModuleEnabled(
      form.event.clientId,
      form.type === "SPONSOR" ? "sponsorships" : "registrations",
    );
    return form;
  }

  @Get(":id/sponsorship-mode-locked")
  async sponsorshipModeLocked(
    @Param() params: FormIdParamDto,
    @Req() req: AuthedRequest,
  ): Promise<{ locked: boolean }> {
    const form = await this.requireOwnedForm(params.id, req.user, "access");
    if (form.type !== "SPONSOR") return { locked: false };
    await assertClientModuleEnabled(form.event.clientId, "sponsorships");
    return { locked: await this.forms.isSponsorshipModeLocked(params.id) };
  }

  @Patch(":id/sponsorship-settings")
  async updateSponsorshipSettings(
    @Param() params: FormIdParamDto,
    @Body() body: UpdateSponsorshipSettingsDto,
    @Req() req: AuthedRequest,
  ): Promise<Form> {
    const form = await this.requireOwnedForm(params.id, req.user, "update");
    assertEventWritable(form.event);
    await assertClientModuleEnabled(form.event.clientId, "sponsorships");
    return this.forms.updateSponsorshipSettings(params.id, body);
  }

  @Patch(":id")
  async update(
    @Param() params: FormIdParamDto,
    @Body() body: UpdateFormDto,
    @Req() req: AuthedRequest,
  ): Promise<Form> {
    const form = await this.requireOwnedForm(params.id, req.user, "update");
    assertEventWritable(form.event);
    await assertClientModuleEnabled(
      form.event.clientId,
      form.type === "SPONSOR" ? "sponsorships" : "registrations",
    );
    return this.forms.updateForm(params.id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @SkipEnvelope()
  async remove(
    @Param() params: FormIdParamDto,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const form = await this.requireOwnedForm(params.id, req.user, "delete");
    assertEventWritable(form.event);
    await assertClientModuleEnabled(
      form.event.clientId,
      form.type === "SPONSOR" ? "sponsorships" : "registrations",
    );
    await this.forms.deleteForm(params.id);
  }

  private requireOwnedEvent(eventId: string, user: AuthUser, message: string) {
    return assertOwned(user, () => getEventWithPricing(eventId), (event) => event.clientId, {
      notFound: "Event not found",
      forbidden: () => new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message }),
    });
  }

  /** Fetch a form + ownership gate (404 then 403), shared by the by-id routes. */
  private async requireOwnedForm(
    id: string,
    user: AuthUser,
    verb: "access" | "update" | "delete",
  ): Promise<FormWithEvent> {
    return assertOwned(user, () => this.forms.getFormById(id), (form) => form.event.clientId, {
      notFound: "Form not found",
      forbidden: () => new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: `Insufficient permissions to ${verb} this form`,
      }),
    });
  }
}
