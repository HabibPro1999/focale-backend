import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { UserRole } from "@app/contracts";

// Real AuthGuard runs; mock only its side-effecting deps (same as clients test).
vi.mock("@app/integrations", () => ({
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));
vi.mock("@app/db", () => ({
  getUserWithClientById: vi.fn(),
  getUserIdsByClient: vi.fn(async () => []),
}));

import { authAs } from "../../testing/auth";
import { createTestApp } from "../../testing/create-test-app";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

const userId = "11111111-1111-4111-8111-111111111111";
let AUTH: ReturnType<typeof authAs>;

const service = {
  createUser: vi.fn(),
  listUsers: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
};

describe("UsersController (routes)", () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    vi.clearAllMocks();
    AUTH = authAs(UserRole.SUPER_ADMIN, null, { name: "Super" });

    app = await createTestApp({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: service }],
    });
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
