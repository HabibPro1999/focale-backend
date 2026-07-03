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
import { ErrorCodes, UserRole } from "@app/contracts";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import type { AuthUser } from "../../core/auth/user-cache";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { UsersService } from "./users.service";
import {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateUserDto,
  UserIdParamDto,
} from "./users.dto";

@Controller("api/users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** GET /api/users/me — current user (any authenticated user, no client relation). */
  @Get("me")
  @Auth()
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  /** POST /api/users — create a user (super admin only). */
  @Post()
  @Auth(UserRole.SUPER_ADMIN)
  @HttpCode(201)
  create(@Body() body: CreateUserDto) {
    return this.users.createUser(body);
  }

  /** GET /api/users — list users (super admin only). */
  @Get()
  @Auth(UserRole.SUPER_ADMIN)
  list(@Query() query: ListUsersQueryDto) {
    return this.users.listUsers(query);
  }

  /** GET /api/users/:id — single user (super admin only). */
  @Get(":id")
  @Auth(UserRole.SUPER_ADMIN)
  async getOne(@Param() params: UserIdParamDto) {
    const user = await this.users.getUserById(params.id);
    if (!user) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "User not found",
      });
    }
    return user;
  }

  /** PATCH /api/users/:id — update a user (super admin only). */
  @Patch(":id")
  @Auth(UserRole.SUPER_ADMIN)
  update(
    @Param() params: UserIdParamDto,
    @Body() body: UpdateUserDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.users.updateUser(params.id, body, user.id);
  }

  /** DELETE /api/users/:id — delete a user (super admin only). 204, bare. */
  @Delete(":id")
  @Auth(UserRole.SUPER_ADMIN)
  @HttpCode(204)
  // Bare 204, no envelope (matches legacy empty-body delete).
  @SkipEnvelope()
  async remove(
    @Param() params: UserIdParamDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.users.deleteUser(params.id, user.id);
  }
}
