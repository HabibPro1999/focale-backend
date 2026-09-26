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
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ErrorCodes, UserRole } from "@app/contracts";
import type { ClientRow } from "@app/db";
import { Auth, RequireRole } from "../../core/auth/auth.decorator";
import { type AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { ClientScoped } from "../tenancy";
import { ClientsService } from "./clients.service";
import {
  CreateClientDto,
  UpdateClientDto,
  ListClientsQueryDto,
  ClientIdParamDto,
} from "./clients.dto";

/** Request after AuthGuard: user (8-field) + client (full row or null) attached. */
type AuthedRequest = FastifyRequest & {
  user: AuthUser;
  client: ClientRow | null;
};

/**
 * Client routes, mounted at /api/clients. Every route requires a valid token
 * (class-level @Auth, so it runs before a route's tenant scope guard); the
 * CRUD routes are super admin only (@RequireRole).
 */
@Auth()
@Controller("api/clients")
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  /** Current user's client. Any authenticated user; reuses request.client (no DB hit). */
  @Get("me")
  async getMe(@Req() req: AuthedRequest): Promise<ClientRow> {
    const { clientId } = req.user;
    if (!clientId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: "User is not associated with any client",
      });
    }
    const client = req.client ?? (await this.clients.getById(clientId));
    if (!client) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Client not found",
      });
    }
    return client;
  }

  @Post()
  @RequireRole(UserRole.SUPER_ADMIN)
  @HttpCode(201)
  create(@Body() body: CreateClientDto): Promise<ClientRow> {
    return this.clients.create(body);
  }

  @Get()
  @RequireRole(UserRole.SUPER_ADMIN)
  list(@Query() query: ListClientsQueryDto) {
    return this.clients.list(query);
  }

  /** Super admin (any client) or a client admin reading their own. Reuses request.client. */
  @Get(":id")
  @ClientScoped()
  async getById(
    @Param() params: ClientIdParamDto,
    @Req() req: AuthedRequest,
  ): Promise<ClientRow> {
    const client =
      req.client?.id === params.id
        ? req.client
        : await this.clients.getById(params.id);
    if (!client) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Client not found",
      });
    }
    return client;
  }

  @Patch(":id")
  @RequireRole(UserRole.SUPER_ADMIN)
  update(
    @Param() params: ClientIdParamDto,
    @Body() body: UpdateClientDto,
  ): Promise<ClientRow> {
    return this.clients.update(params.id, body);
  }

  @Delete(":id")
  @RequireRole(UserRole.SUPER_ADMIN)
  @HttpCode(204)
  // Bare 204, no envelope (matches legacy empty-body delete).
  @SkipEnvelope()
  async remove(@Param() params: ClientIdParamDto): Promise<void> {
    await this.clients.remove(params.id);
  }
}
