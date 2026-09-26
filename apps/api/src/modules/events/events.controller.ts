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
import { type AuthUser } from "../../core/auth/user-cache";
import { EventScoped, requireTenantScope } from "../tenancy";
import { EventsService } from "./events.service";
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

/**
 * Admin event CRUD — mounted at /api/events. Every route requires a valid token
 * and the admin role (@Auth(CLIENT_ADMIN): super admin or client admin). Routes
 * on one event declare their tenant scope (`:id`); create checks the client
 * named in its body the same way.
 */
@Auth(UserRole.CLIENT_ADMIN)
@Controller("api/events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  @HttpCode(201)
  async create(@CurrentUser() u: AuthUser, @Body() body: CreateEventDto) {
    await requireTenantScope(u, "client", body.clientId);
    return this.events.createEvent(body);
  }

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query() query: ListEventsQueryDto) {
    const q = { ...query };
    if (u.role === UserRole.CLIENT_ADMIN) {
      if (!u.clientId) {
        throw new ForbiddenException({
          code: ErrorCodes.FORBIDDEN,
          message: "User is not associated with any client",
        });
      }
      q.clientId = u.clientId;
    }
    return this.events.listEvents(q);
  }

  @Get(":id")
  @EventScoped({ param: "id" })
  async getById(@Param() params: EventIdParamDto) {
    const event = await this.events.getEventById(params.id);
    if (!event) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: "Event not found" });
    }
    return event;
  }

  @Patch(":id")
  @EventScoped({ param: "id" })
  async update(@Param() params: EventIdParamDto, @Body() body: UpdateEventDto) {
    return this.events.updateEvent(params.id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @SkipEnvelope() // bare 204, no body/envelope (legacy parity)
  @EventScoped({ param: "id" })
  async remove(@Param() params: EventIdParamDto) {
    await this.events.deleteEvent(params.id);
  }

  @Post(":id/banner")
  @HttpCode(200)
  @EventScoped({ param: "id", write: true })
  async uploadBanner(
    @Param() params: EventIdParamDto,
    @Req() req: MultipartRequest,
  ) {
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
