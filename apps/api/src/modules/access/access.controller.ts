import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ErrorCodes, type CreateEventAccessInput } from "@app/contracts";
import { Auth } from "../../core/auth/auth.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { AccessItemScoped, EventScoped } from "../tenancy";
import { AccessService } from "./access.service";
import {
  AccessEventIdParamDto,
  CreateEventAccessBodyDto,
  EventAccessIdParamDto,
  ListEventAccessQueryDto,
  UpdateEventAccessDto,
} from "./access.dto";

/**
 * Admin access-item routes, mounted at /api/events. Every route requires a valid
 * token (@Auth) and declares its tenant scope (event or access item → event →
 * client, registrations module; writes refuse an archived event). NOTE:
 * /access/:id is a SIBLING of /:eventId/access.
 */
@Auth()
@Controller("api/events")
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Post(":eventId/access")
  @HttpCode(201)
  @EventScoped({ module: "registrations", write: true })
  async create(
    @Param() params: AccessEventIdParamDto,
    @Body() body: CreateEventAccessBodyDto,
  ) {
    const input = { ...body, eventId: params.eventId } as CreateEventAccessInput;
    return this.access.createEventAccess(input);
  }

  @Get(":eventId/access")
  @EventScoped({ module: "registrations" })
  async list(
    @Param() params: AccessEventIdParamDto,
    @Query() query: ListEventAccessQueryDto,
  ) {
    return this.access.listEventAccess(params.eventId, {
      active: query.active,
      type: query.type,
    });
  }

  @Get("access/:id")
  @AccessItemScoped({ module: "registrations" })
  async getOne(@Param() params: EventAccessIdParamDto) {
    const access = await this.access.getEventAccessById(params.id);
    if (!access) {
      throw new NotFoundException({
        code: ErrorCodes.ACCESS_NOT_FOUND,
        message: "Access item not found",
      });
    }
    return access;
  }

  @Patch("access/:id")
  @AccessItemScoped({ module: "registrations", write: true })
  async update(
    @Param() params: EventAccessIdParamDto,
    @Body() body: UpdateEventAccessDto,
  ) {
    return this.access.updateEventAccess(params.id, body);
  }

  @Delete("access/:id")
  @HttpCode(204)
  @SkipEnvelope() // bare 204, no body/envelope (legacy parity)
  @AccessItemScoped({ module: "registrations", write: true })
  async remove(@Param() params: EventAccessIdParamDto) {
    await this.access.deleteEventAccess(params.id);
  }
}
