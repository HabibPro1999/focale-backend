import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Module } from "@nestjs/common";
import {
  APP_FILTER,
  APP_INTERCEPTOR,
  APP_PIPE,
  NestFactory,
  Reflector,
} from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { UserRole } from "@app/contracts";

// Real AuthGuard runs; mock only its side-effecting deps (same as clients test).
vi.mock("@app/integrations", () => ({
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));
vi.mock("@app/db", () => ({
  getUserWithClientById: vi.fn(),
  getUserIdsByClient: vi.fn(async () => []),
}));

import { getUserWithClientById } from "@app/db";
import { clearUserCache } from "../../core/auth/user-cache";
import { ZodValidationPipe } from "../../core/zod";
import { EnvelopeInterceptor } from "../../core/envelope.interceptor";
import { HttpExceptionFilter } from "../../core/http-exception.filter";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

const getUser = vi.mocked(getUserWithClientById);
const userId = "11111111-1111-4111-8111-111111111111";
const AUTH = { authorization: "Bearer test" };

const service = {
  createUser: vi.fn(),
  listUsers: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
};

@Module({
  controllers: [UsersController],
  providers: [
    { provide: UsersService, useValue: service },
    Reflector,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class TestUsersModule {}

describe("UsersController (routes)", () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearUserCache();
    getUser.mockResolvedValue({
      id: "u1",
      email: "u1@example.com",
      name: "Super",
      role: UserRole.SUPER_ADMIN,
      clientId: null,
      active: true,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
      client: null,
      // deleteUser fixture shape is irrelevant here; guard only reads the above.
    } as never);

    app = await NestFactory.create<NestFastifyApplication>(
      TestUsersModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("DELETE /api/users/:id returns a bare 204 (no envelope body, matches legacy)", async () => {
    service.deleteUser.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${userId}`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(service.deleteUser).toHaveBeenCalledWith(userId, "u1");
  });
});
