import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestApp } from "../helpers/test-app.js";
import {
  mockAuthenticatedUser,
  mockUnauthenticated,
  mockInactiveUser,
  mockUserNotFound,
} from "../helpers/auth-helpers.js";
import { clearUserCache } from "../../src/shared/middleware/auth.middleware.js";
import { UserRole } from "../helpers/factories.js";
import type { AppInstance } from "../../src/shared/types/fastify.js";

describe("Auth Middleware Wiring", () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // Clear the 60-second user cache to prevent cross-test interference
    clearUserCache();
  });

  it("missing Authorization header returns 401", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/users/me",
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBeDefined();
    expect(body.code).toBeDefined();
  });

  it("invalid or expired token returns 401", async () => {
    mockUnauthenticated();

    const response = await app.inject({
      method: "GET",
      url: "/api/users/me",
      headers: {
        authorization: "Bearer invalid-or-expired-token",
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBeDefined();
    expect(body.code).toBeDefined();
  });

  it("valid token with user not in database returns 401", async () => {
    mockUserNotFound();

    const response = await app.inject({
      method: "GET",
      url: "/api/users/me",
      headers: {
        authorization: "Bearer valid-token-no-user",
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBeDefined();
    expect(body.code).toBeDefined();
  });

  it("valid token with inactive user returns 401", async () => {
    // Provide explicit id/email/name so overrides don't clobber faker values
    const { headers } = mockInactiveUser({
      role: UserRole.CLIENT_ADMIN,
      id: "inactive-user-id",
      email: "inactive@example.com",
      name: "Inactive User",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/users/me",
      headers,
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.message).toBeDefined();
    expect(body.code).toBeDefined();
  });

  it("valid token with super admin returns 200 on GET /api/users/me", async () => {
    // Provide explicit id/email/name so overrides don't clobber faker values
    const { headers, user } = mockAuthenticatedUser({
      role: UserRole.SUPER_ADMIN,
      id: "super-admin-user-id",
      email: "superadmin@example.com",
      name: "Super Admin",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/users/me",
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(user.id);
    expect(body.email).toBe(user.email);
    expect(body.role).toBe(UserRole.SUPER_ADMIN);
  });

  it("client admin on super-admin-only route returns 403", async () => {
    // Provide explicit id/email/name so overrides don't clobber faker values
    const { headers } = mockAuthenticatedUser({
      role: UserRole.CLIENT_ADMIN,
      id: "client-admin-user-id",
      email: "clientadmin@example.com",
      name: "Client Admin",
    });

    // GET /api/users is restricted to super_admin via requireSuperAdmin preHandler
    const response = await app.inject({
      method: "GET",
      url: "/api/users",
      headers,
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.message).toBeDefined();
    expect(body.code).toBeDefined();
  });
});
