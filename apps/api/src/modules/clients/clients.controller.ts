import { notFound } from "../../core/app-exception";
import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { ErrorCodes, UserRole } from "@app/contracts";
import type { ClientRow } from "@app/db";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { CurrentClient } from "../../core/auth/current-client.decorator";
import {
  canAccessClient,
  type AuthUser,
} from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { ClientsService } from "./clients.service";
import {
  CreateClientDto,
  UpdateClientDto,
  ListClientsQueryDto,
  ClientIdParamDto,
} from "./clients.dto";

@Controller("api/clients")
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  /** Current user's client. Any authenticated user; reuses request.client (no DB hit). */
  @Get("me")
  @Auth()
  async getMe(
    @CurrentUser() user: AuthUser,
    @CurrentClient() currentClient: ClientRow | null | undefined,
  ): Promise<ClientRow> {
    const { clientId } = user;
    if (!clientId) {
      throw notFound("User is not associated with any client");
    }
    const client = currentClient ?? (await this.clients.getById(clientId));
    if (!client) {
      throw notFound("Client not found");
    }
    return client;
  }

  @Post()
  @Auth(UserRole.SUPER_ADMIN)
  @HttpCode(201)
  create(@Body() body: CreateClientDto): Promise<ClientRow> {
    return this.clients.create(body);
  }

  @Get()
  @Auth(UserRole.SUPER_ADMIN)
  list(@Query() query: ListClientsQueryDto) {
    return this.clients.list(query);
  }

  /** Super admin (any client) or a client admin reading their own. Reuses request.client. */
  @Get(":id")
  @Auth()
  async getById(
    @Param() params: ClientIdParamDto,
    @CurrentUser() user: AuthUser,
    @CurrentClient() currentClient: ClientRow | null | undefined,
  ): Promise<ClientRow> {
    if (!canAccessClient(user, params.id)) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: "Insufficient permissions to access this client",
      });
    }
    const client =
      currentClient?.id === params.id
        ? currentClient
        : await this.clients.getById(params.id);
    if (!client) {
      throw notFound("Client not found");
    }
    return client;
  }

  @Patch(":id")
  @Auth(UserRole.SUPER_ADMIN)
  update(
    @Param() params: ClientIdParamDto,
    @Body() body: UpdateClientDto,
  ): Promise<ClientRow> {
    return this.clients.update(params.id, body);
  }

  @Delete(":id")
  @Auth(UserRole.SUPER_ADMIN)
  @HttpCode(204)
  // Bare 204, no envelope (matches legacy empty-body delete).
  @SkipEnvelope()
  async remove(@Param() params: ClientIdParamDto): Promise<void> {
    await this.clients.remove(params.id);
  }
}
