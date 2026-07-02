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
import { ErrorCodes, UserRole } from "@app/contracts";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import {
  EventsService,
  canAccessClient,
  assertEventWritable,
  type AuthUser,
} from "./events.service";
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
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: "User is not associated with any client",
        });
      }
      q.clientId = u.clientId;
    }
    return this.events.listEvents(q);
  }

  @Get(":id")
  async getById(@CurrentUser() u: AuthUser, @Param() params: EventIdParamDto) {
    assertAdmin(u);
    const event = await this.events.getEventById(params.id);
    if (!event) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: "Event not found" });
    if (!canAccessClient(u, event.clientId)) {
      throw forbidden("Insufficient permissions to access this event");
    }
    return event;
  }

  @Patch(":id")
  async update(
    @CurrentUser() u: AuthUser,
    @Param() params: EventIdParamDto,
    @Body() body: UpdateEventDto,
  ) {
    assertAdmin(u);
    const event = await this.events.getEventById(params.id);
    if (!event) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: "Event not found" });
    if (!canAccessClient(u, event.clientId)) {
      throw forbidden("Insufficient permissions to update this event");
    }
    return this.events.updateEvent(params.id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @SkipEnvelope() // bare 204, no body/envelope (legacy parity)
  async remove(@CurrentUser() u: AuthUser, @Param() params: EventIdParamDto) {
    assertAdmin(u);
    const event = await this.events.getEventById(params.id);
    if (!event) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: "Event not found" });
    if (!canAccessClient(u, event.clientId)) {
      throw forbidden("Insufficient permissions to delete this event");
    }
    await this.events.deleteEvent(params.id);
  }

  @Post(":id/banner")
  @HttpCode(200)
  async uploadBanner(
    @CurrentUser() u: AuthUser,
    @Param() params: EventIdParamDto,
    @Req() req: MultipartRequest,
  ) {
    assertAdmin(u);
    const event = await this.events.getEventById(params.id);
    if (!event) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: "Event not found" });
    if (!canAccessClient(u, event.clientId)) {
      throw forbidden("Insufficient permissions to update this event");
    }
    assertEventWritable(event);

    const data = await req.file();
    if (!data) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: "No file uploaded",
      });
    }

    const buffer = await data.toBuffer();
    return this.events.uploadEventBanner(params.id, {
      buffer,
      filename: data.filename,
      mimetype: data.mimetype,
    });
  }
}
