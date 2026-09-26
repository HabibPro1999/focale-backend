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
  Query,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ErrorCodes, UserRole, type ModuleId } from "@app/contracts";
import type { ClientRow, Form, FormWithEvent } from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { type AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { EventScoped, FormScoped, requireTenantScope } from "../tenancy";
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

/** Modules a form list needs, by the form type it asks for (none: both). */
const LIST_MODULES: Record<"SPONSOR" | "REGISTRATION" | "ANY", ModuleId[]> = {
  SPONSOR: ["sponsorships"],
  REGISTRATION: ["registrations"],
  ANY: ["registrations", "sponsorships"],
};

// requireAdmin: @Auth(CLIENT_ADMIN) = role <= 1 (super_admin or client_admin).
// Routes on one form or one event declare their tenant scope; create and list
// check the event named in their body or query the same way.
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
    await requireTenantScope(req.user, "event", body.eventId, {
      module: "registrations",
      write: true,
    });
    return this.forms.createForm(body);
  }

  @Get()
  async list(
    @Query() query: ListFormsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<PaginatedResult<Form>> {
    if (req.user.role === UserRole.CLIENT_ADMIN) {
      if (!req.user.clientId) {
        throw new ForbiddenException({
          code: ErrorCodes.FORBIDDEN,
          message: "User is not associated with any client",
        });
      }
      if (!query.eventId) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: "Event ID is required for client admin users",
        });
      }
    }

    if (query.eventId) {
      await requireTenantScope(req.user, "event", query.eventId, {
        module: LIST_MODULES[query.type ?? "ANY"],
      });
    }

    return this.forms.listForms(query);
  }

  @Get("events/:id/sponsor")
  @EventScoped({ param: "id", module: "sponsorships" })
  async getSponsorByEvent(@Param() params: EventIdParamDto): Promise<Form> {
    const form = await this.forms.getSponsorFormByEventId(params.id);
    if (!form) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Sponsor form not found for this event",
      });
    }
    return form;
  }

  @Post("events/:id/sponsor")
  @HttpCode(201)
  @EventScoped({ param: "id", module: "sponsorships", write: true })
  async createSponsorByEvent(
    @Param() params: EventIdParamDto,
    @Body() body: CreateSponsorFormBodyDto,
  ): Promise<Form> {
    return this.forms.createSponsorForm(params.id, body?.name);
  }

  @Get(":id")
  @FormScoped({ moduleOfFormType: true })
  async getOne(@Param() params: FormIdParamDto): Promise<FormWithEvent> {
    return this.loadForm(params.id);
  }

  @Get(":id/sponsorship-mode-locked")
  @FormScoped({ moduleOfFormType: true })
  async sponsorshipModeLocked(
    @Param() params: FormIdParamDto,
  ): Promise<{ locked: boolean }> {
    const form = await this.loadForm(params.id);
    if (form.type !== "SPONSOR") return { locked: false };
    return { locked: await this.forms.isSponsorshipModeLocked(params.id) };
  }

  @Patch(":id/sponsorship-settings")
  @FormScoped({ module: "sponsorships", write: true })
  async updateSponsorshipSettings(
    @Param() params: FormIdParamDto,
    @Body() body: UpdateSponsorshipSettingsDto,
  ): Promise<Form> {
    return this.forms.updateSponsorshipSettings(params.id, body);
  }

  @Patch(":id")
  @FormScoped({ moduleOfFormType: true, write: true })
  async update(
    @Param() params: FormIdParamDto,
    @Body() body: UpdateFormDto,
  ): Promise<Form> {
    return this.forms.updateForm(params.id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @SkipEnvelope()
  @FormScoped({ moduleOfFormType: true, write: true })
  async remove(@Param() params: FormIdParamDto): Promise<void> {
    await this.forms.deleteForm(params.id);
  }

  /** The full form, after the guard (404 if it was deleted since). */
  private async loadForm(id: string): Promise<FormWithEvent> {
    const form = await this.forms.getFormById(id);
    if (!form) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Form not found",
      });
    }
    return form;
  }
}
