import { assertOwned } from "../../core/tenancy/ownership";
import { badRequest } from "../../core/app-exception";
import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ErrorCodes, UserRole } from "@app/contracts";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { EventsService } from "./events.service";
import { assertEventWritable } from "../../core/tenancy/event-status";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";
import {
  CreateEventDto,
  UpdateEventDto,
  ListEventsQueryDto,
  EventIdParamDto,
} from "./events.dto";

// @fastify/multipart augments the request with .file(); minimal shape used here.
type MultipartFile = {
  filename: string;
  mimetype: string;
  toBuffer(): Promise<Buffer>;
};
type MultipartRequest = FastifyRequest & {
  file(): Promise<MultipartFile | undefined>;
};

function forbidden(message: string): ForbiddenException {
  return new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message });
}

// Module-wide requireAdmin: role must be SUPER_ADMIN or CLIENT_ADMIN.
function assertAdmin(user: AuthUser): void {
  if (user.role !== UserRole.SUPER_ADMIN && user.role !== UserRole.CLIENT_ADMIN) {
    throw forbidden("Insufficient permissions");
  }
}

/**
 * Admin event CRUD — mounted at /api/events. Every route requires a valid token
 * (@Auth) AND admin role (assertAdmin), matching the legacy module-wide hooks.
 */
@Auth()
@Controller("api/events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** assertAdmin → fetch (404) → ownership (403, per-action message). */
  private async requireOwnedEvent(u: AuthUser, id: string, action: string) {
    assertAdmin(u);
    return assertOwned(u, () => this.events.getEventById(id), (event) => event.clientId, {
      notFound: "Event not found",
      forbidden: () => forbidden(`Insufficient permissions to ${action} this event`),
    });
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentUser() u: AuthUser, @Body() body: CreateEventDto) {
    assertAdmin(u);
    if (!canAccessClient(u, body.clientId)) {
      throw forbidden("Insufficient permissions to create event for this client");
    }
    return this.events.createEvent(body);
  }

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query() query: ListEventsQueryDto) {
    assertAdmin(u);
    const q = { ...query };
    if (u.role === UserRole.CLIENT_ADMIN) {
      if (!u.clientId) {
        throw badRequest("User is not associated with any client");
      }
      q.clientId = u.clientId;
    }
    return this.events.listEvents(q);
  }

  @Get(":id")
  async getById(@CurrentUser() u: AuthUser, @Param() params: EventIdParamDto) {
    return this.requireOwnedEvent(u, params.id, "access");
  }

  @Patch(":id")
  async update(
    @CurrentUser() u: AuthUser,
    @Param() params: EventIdParamDto,
    @Body() body: UpdateEventDto,
  ) {
    await this.requireOwnedEvent(u, params.id, "update");
    return this.events.updateEvent(params.id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @SkipEnvelope() // bare 204, no body/envelope (legacy parity)
  async remove(@CurrentUser() u: AuthUser, @Param() params: EventIdParamDto) {
    await this.requireOwnedEvent(u, params.id, "delete");
    await this.events.deleteEvent(params.id);
  }

  @Post(":id/banner")
  @HttpCode(200)
  async uploadBanner(
    @CurrentUser() u: AuthUser,
    @Param() params: EventIdParamDto,
    @Req() req: MultipartRequest,
  ) {
    const event = await this.requireOwnedEvent(u, params.id, "update");
    assertEventWritable(event);

    const data = await req.file();
    if (!data) {
      throw badRequest("No file uploaded");
    }

    const buffer = await data.toBuffer();
    return this.events.uploadEventBanner(params.id, {
      buffer,
      filename: data.filename,
      mimetype: data.mimetype,
    });
  }
}
