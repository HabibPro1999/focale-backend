import {
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
} from "@nestjs/common";
import type { CreateEventAccessInput } from "@app/contracts";
import { getEventWithPricing } from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { assertEventWritable } from "../events/events.service";
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
 * token (@Auth); per-route ownership is enforced via canAccessClient against the
 * owning event's client. Route-level 404/403 are plain (code derived by the
 * global filter, no details). NOTE: /access/:id is a SIBLING of /:eventId/access.
 */
@Auth()
@Controller("api/events")
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Post(":eventId/access")
  @HttpCode(201)
  async create(
    @CurrentUser() user: AuthUser,
    @Param() params: AccessEventIdParamDto,
    @Body() body: CreateEventAccessBodyDto,
  ) {
    const event = await getEventWithPricing(params.eventId);
    if (!event) throw new NotFoundException("Event not found");
    if (!canAccessClient(user, event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "registrations");

    const input = { ...body, eventId: params.eventId } as CreateEventAccessInput;
    return this.access.createEventAccess(input);
  }

  @Get(":eventId/access")
  async list(
    @CurrentUser() user: AuthUser,
    @Param() params: AccessEventIdParamDto,
    @Query() query: ListEventAccessQueryDto,
  ) {
    const event = await getEventWithPricing(params.eventId);
    if (!event) throw new NotFoundException("Event not found");
    if (!canAccessClient(user, event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    await assertClientModuleEnabled(event.clientId, "registrations");

    return this.access.listEventAccess(params.eventId, {
      active: query.active,
      type: query.type,
    });
  }

  @Get("access/:id")
  async getOne(
    @CurrentUser() user: AuthUser,
    @Param() params: EventAccessIdParamDto,
  ) {
    const access = await this.access.getEventAccessById(params.id);
    if (!access) throw new NotFoundException("Access item not found");

    const event = await getEventWithPricing(access.eventId);
    if (!event) throw new NotFoundException("Event not found");
    if (!canAccessClient(user, event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    await assertClientModuleEnabled(event.clientId, "registrations");

    return access;
  }

  @Patch("access/:id")
  async update(
    @CurrentUser() user: AuthUser,
    @Param() params: EventAccessIdParamDto,
    @Body() body: UpdateEventAccessDto,
  ) {
    const access = await this.access.getEventAccessById(params.id);
    if (!access) throw new NotFoundException("Access item not found");

    const event = await getEventWithPricing(access.eventId);
    if (!event) throw new NotFoundException("Event not found");
    if (!canAccessClient(user, event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "registrations");

    return this.access.updateEventAccess(params.id, body);
  }

  @Delete("access/:id")
  @HttpCode(204)
  @SkipEnvelope() // bare 204, no body/envelope (legacy parity)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param() params: EventAccessIdParamDto,
  ) {
    const access = await this.access.getEventAccessById(params.id);
    if (!access) throw new NotFoundException("Access item not found");

    const event = await getEventWithPricing(access.eventId);
    if (!event) throw new NotFoundException("Event not found");
    if (!canAccessClient(user, event.clientId)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    assertEventWritable(event);
    await assertClientModuleEnabled(event.clientId, "registrations");

    await this.access.deleteEventAccess(params.id);
  }
}
