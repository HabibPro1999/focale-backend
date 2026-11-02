import { beforeEach, describe, expect, it, vi } from "vitest";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ErrorCodes, UserRole } from "@app/contracts";
import { AuthGuard } from "./auth.guard";
import { userCache } from "./user-cache";
import { verifyToken } from "@app/integrations";
import { getDb, getUserWithClientById, recordUserLogin } from "@app/db";

vi.mock("@app/integrations", () => ({ verifyToken: vi.fn(async () => ({ uid: "disabled-test-user" })) }));
vi.mock("@app/db", () => ({ getDb: () => ({ executor: "test" }), recordUserLogin: vi.fn(async () => {}), getUserWithClientById: vi.fn(async () => ({ id: "disabled-test-user", active: false,
  name: "Synthetic", email: "disabled@example.test", role: UserRole.SUPER_ADMIN, clientId: null, client: null,
  createdAt: new Date(0), updatedAt: new Date(0) })) }));

describe("deactivated user error code (Firebase mocked; no network)", () => {
  beforeEach(() => userCache.invalidate("disabled-test-user"));
  it("returns a distinct 401 code instead of masking it as an invalid token", async () => {
    const context = { switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: "Bearer synthetic" } }) }) } as unknown as ExecutionContext;
    await expect(new AuthGuard(new Reflector()).canActivate(context)).rejects.toMatchObject({ status: 401,
      response: { code: ErrorCodes.USER_INACTIVE, message: "User account is disabled" } });
  });
  it("records verified login time once, never request time or an older token", async () => {
    const login = Math.floor(Date.now() / 1000) - 60;
    vi.mocked(getUserWithClientById).mockResolvedValue({ id: "disabled-test-user", active: true,
      role: UserRole.SUPER_ADMIN, client: null, lastLoginAt: null } as never);
    vi.mocked(verifyToken).mockResolvedValue({ uid: "disabled-test-user", auth_time: login } as never);
    const context = { switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: "Bearer synthetic" } }) }),
      getHandler: () => () => {}, getClass: () => class {} } as unknown as ExecutionContext;
    const guard = new AuthGuard(new Reflector());
    await guard.canActivate(context);
    await guard.canActivate(context);
    vi.mocked(verifyToken).mockResolvedValue({ uid: "disabled-test-user", auth_time: login - 30 } as never);
    await guard.canActivate(context);
    expect(recordUserLogin).toHaveBeenCalledExactlyOnceWith("disabled-test-user", new Date(login * 1000), getDb());
  });
});
