import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpException } from "@nestjs/common";
import { ErrorCodes, UserRole } from "@app/contracts";

// The service depends on the packages/db query layer and the integrations
// Firebase layer — both are mocked. Assertions are re-derived from behavior
// (status/code, which side-effects fire), not from Prisma call shapes.
vi.mock("@app/db", () => ({
  clientExists: vi.fn(),
  countActiveSuperAdmins: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserById: vi.fn(),
  getUserWithClientById: vi.fn(),
  listUsers: vi.fn(),
  updateUser: vi.fn(),
  getUserIdsByClient: vi.fn(),
}));
vi.mock("@app/integrations", () => ({
  createFirebaseUser: vi.fn(),
  deleteFirebaseUser: vi.fn(),
  revokeFirebaseRefreshTokens: vi.fn(),
  setCustomClaims: vi.fn(),
}));

import * as db from "@app/db";
import * as fb from "@app/integrations";
import { UsersService } from "./users.service";

const dbm = vi.mocked(db);
const fbm = vi.mocked(fb);

type Row = {
  id: string;
  email: string;
  name: string;
  role: number;
  clientId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function makeUser(over: Partial<Row> = {}): Row {
  return {
    id: "user-123",
    email: "user@example.com",
    name: "User",
    role: UserRole.CLIENT_ADMIN,
    clientId: "client-123",
    active: true,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...over,
  };
}
const makeSuperAdmin = (over: Partial<Row> = {}) =>
  makeUser({ id: "admin-123", role: UserRole.SUPER_ADMIN, clientId: null, ...over });

async function catchErr(thunk: () => Promise<unknown>): Promise<HttpException> {
  try {
    await thunk();
  } catch (e) {
    return e as HttpException;
  }
  throw new Error("expected the call to throw");
}
async function expectHttp(
  thunk: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const e = await catchErr(thunk);
  expect(e).toBeInstanceOf(HttpException);
  expect(e.getStatus()).toBe(status);
  expect((e.getResponse() as { code: string }).code).toBe(code);
}

const service = new UsersService();

beforeEach(() => {
  vi.resetAllMocks();
});

// ============================================================================
// createUser
// ============================================================================
describe("createUser", () => {
  const validClientAdminInput = {
    email: "test@example.com",
    password: "Password123!",
    name: "Test User",
    role: UserRole.CLIENT_ADMIN,
    clientId: "client-123",
  };
  const validSuperAdminInput = {
    email: "admin@example.com",
    password: "Password123!",
    name: "Super Admin",
    role: UserRole.SUPER_ADMIN,
    clientId: null,
  };

  it("creates a CLIENT_ADMIN with a valid client", async () => {
    const expected = makeUser({ id: "firebase-uid", email: "test@example.com" });
    dbm.getUserByEmail.mockResolvedValue(undefined);
    dbm.clientExists.mockResolvedValue(true);
    fbm.createFirebaseUser.mockResolvedValue({ uid: "firebase-uid" } as never);
    fbm.setCustomClaims.mockResolvedValue(undefined);
    dbm.createUser.mockResolvedValue(expected as never);

    const result = await service.createUser(validClientAdminInput);

    expect(result).toEqual(expected);
    expect(dbm.getUserByEmail).toHaveBeenCalledWith("test@example.com");
    expect(dbm.clientExists).toHaveBeenCalledWith("client-123");
    expect(fbm.createFirebaseUser).toHaveBeenCalledWith(
      "test@example.com",
      "Password123!",
    );
    expect(fbm.setCustomClaims).toHaveBeenCalledWith("firebase-uid", {
      role: UserRole.CLIENT_ADMIN,
      clientId: "client-123",
    });
    expect(dbm.createUser).toHaveBeenCalledWith({
      id: "firebase-uid",
      email: "test@example.com",
      name: "Test User",
      role: UserRole.CLIENT_ADMIN,
      clientId: "client-123",
    });
  });

  it("normalizes email across uniqueness check, Firebase create, and DB create", async () => {
    dbm.getUserByEmail.mockResolvedValue(undefined);
    dbm.clientExists.mockResolvedValue(true);
    fbm.createFirebaseUser.mockResolvedValue({ uid: "firebase-uid" } as never);
    fbm.setCustomClaims.mockResolvedValue(undefined);
    dbm.createUser.mockResolvedValue(makeUser() as never);

    await service.createUser({
      ...validClientAdminInput,
      email: "  User@Example.COM ",
    });

    expect(dbm.getUserByEmail).toHaveBeenCalledWith("user@example.com");
    expect(fbm.createFirebaseUser).toHaveBeenCalledWith(
      "user@example.com",
      "Password123!",
    );
    expect(dbm.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "user@example.com" }),
    );
  });

  it("creates a SUPER_ADMIN without a client (no client validation)", async () => {
    dbm.getUserByEmail.mockResolvedValue(undefined);
    fbm.createFirebaseUser.mockResolvedValue({ uid: "firebase-uid" } as never);
    fbm.setCustomClaims.mockResolvedValue(undefined);
    dbm.createUser.mockResolvedValue(makeSuperAdmin({ id: "firebase-uid" }) as never);

    await service.createUser(validSuperAdminInput);

    expect(dbm.clientExists).not.toHaveBeenCalled();
    expect(fbm.setCustomClaims).toHaveBeenCalledWith("firebase-uid", {
      role: UserRole.SUPER_ADMIN,
      clientId: null,
    });
  });

  it("rejects a duplicate email with 409 CONFLICT and never touches Firebase", async () => {
    dbm.getUserByEmail.mockResolvedValue(makeUser() as never);
    await expectHttp(
      () => service.createUser(validClientAdminInput),
      409,
      ErrorCodes.CONFLICT,
    );
    expect(fbm.createFirebaseUser).not.toHaveBeenCalled();
  });

  it("rejects CLIENT_ADMIN without clientId (400 VALIDATION_ERROR)", async () => {
    dbm.getUserByEmail.mockResolvedValue(undefined);
    await expectHttp(
      () =>
        service.createUser({ ...validClientAdminInput, clientId: undefined }),
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  });

  it("rejects SUPER_ADMIN with clientId (400 VALIDATION_ERROR)", async () => {
    dbm.getUserByEmail.mockResolvedValue(undefined);
    await expectHttp(
      () =>
        service.createUser({ ...validSuperAdminInput, clientId: "client-123" }),
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  });

  it("rejects a nonexistent clientId (400 BAD_REQUEST)", async () => {
    dbm.getUserByEmail.mockResolvedValue(undefined);
    dbm.clientExists.mockResolvedValue(false);
    await expectHttp(
      () => service.createUser(validClientAdminInput),
      400,
      ErrorCodes.BAD_REQUEST,
    );
  });

  it("propagates DB creation errors and rolls back the Firebase user", async () => {
    dbm.getUserByEmail.mockResolvedValue(undefined);
    dbm.clientExists.mockResolvedValue(true);
    fbm.createFirebaseUser.mockResolvedValue({ uid: "firebase-uid" } as never);
    fbm.setCustomClaims.mockResolvedValue(undefined);
    dbm.createUser.mockRejectedValue(new Error("Database error"));
    fbm.deleteFirebaseUser.mockResolvedValue(undefined);

    await expect(service.createUser(validClientAdminInput)).rejects.toThrow(
      "Database error",
    );
    expect(fbm.deleteFirebaseUser).toHaveBeenCalledWith("firebase-uid");
  });

  it("rolls back the Firebase user when setCustomClaims fails", async () => {
    dbm.getUserByEmail.mockResolvedValue(undefined);
    dbm.clientExists.mockResolvedValue(true);
    fbm.createFirebaseUser.mockResolvedValue({ uid: "firebase-uid" } as never);
    fbm.setCustomClaims.mockRejectedValue(new Error("setCustomClaims failed"));
    fbm.deleteFirebaseUser.mockResolvedValue(undefined);

    await expect(service.createUser(validClientAdminInput)).rejects.toThrow(
      "setCustomClaims failed",
    );
    expect(fbm.deleteFirebaseUser).toHaveBeenCalledWith("firebase-uid");
    expect(dbm.createUser).not.toHaveBeenCalled();
  });
});

// ============================================================================
// getUserById
// ============================================================================
describe("getUserById", () => {
  it("returns the user with its client when found", async () => {
    const uwc = { ...makeUser(), client: { id: "client-123" } };
    dbm.getUserWithClientById.mockResolvedValue(uwc as never);
    expect(await service.getUserById("user-123")).toEqual(uwc);
  });

  it("returns a user with null client for a super admin", async () => {
    const uwc = { ...makeSuperAdmin(), client: null };
    dbm.getUserWithClientById.mockResolvedValue(uwc as never);
    const result = await service.getUserById("admin-123");
    expect(result?.client).toBeNull();
  });

  it("returns null when not found", async () => {
    dbm.getUserWithClientById.mockResolvedValue(undefined);
    expect(await service.getUserById("nope")).toBeNull();
  });
});

// ============================================================================
// updateUser
// ============================================================================
describe("updateUser", () => {
  it("updates the name without syncing Firebase claims", async () => {
    const existing = makeUser({ name: "Old" });
    dbm.getUserById.mockResolvedValue(existing as never);
    dbm.updateUser.mockResolvedValue({
      ...existing,
      name: "New Name",
      client: null,
    } as never);

    const result = await service.updateUser("user-123", { name: "New Name" });

    expect(result.name).toBe("New Name");
    expect(fbm.setCustomClaims).not.toHaveBeenCalled();
    expect(dbm.updateUser).toHaveBeenCalledWith("user-123", {
      name: "New Name",
    });
  });

  it("syncs claims and revokes tokens on a role change", async () => {
    const existing = makeUser();
    dbm.getUserById.mockResolvedValue(existing as never);
    fbm.setCustomClaims.mockResolvedValue(undefined);
    dbm.updateUser.mockResolvedValue({
      ...existing,
      role: UserRole.SUPER_ADMIN,
      clientId: null,
      client: null,
    } as never);

    const result = await service.updateUser("user-123", {
      role: UserRole.SUPER_ADMIN,
      clientId: null,
    });

    expect(result.role).toBe(UserRole.SUPER_ADMIN);
    expect(fbm.setCustomClaims).toHaveBeenCalledWith("user-123", {
      role: UserRole.SUPER_ADMIN,
      clientId: null,
    });
    expect(fbm.revokeFirebaseRefreshTokens).toHaveBeenCalledWith("user-123");
  });

  it("syncs claims with the existing role on a clientId-only change", async () => {
    const existing = makeUser();
    dbm.getUserById.mockResolvedValue(existing as never);
    dbm.clientExists.mockResolvedValue(true);
    fbm.setCustomClaims.mockResolvedValue(undefined);
    dbm.updateUser.mockResolvedValue({
      ...existing,
      clientId: "client-456",
      client: null,
    } as never);

    await service.updateUser("user-123", { clientId: "client-456" });

    expect(dbm.clientExists).toHaveBeenCalledWith("client-456");
    expect(fbm.setCustomClaims).toHaveBeenCalledWith("user-123", {
      role: UserRole.CLIENT_ADMIN,
      clientId: "client-456",
    });
  });

  it("revokes tokens on deactivation but does not sync claims", async () => {
    const existing = makeUser({ active: true });
    dbm.getUserById.mockResolvedValue(existing as never);
    dbm.updateUser.mockResolvedValue({
      ...existing,
      active: false,
      client: null,
    } as never);
    fbm.revokeFirebaseRefreshTokens.mockResolvedValue(undefined);

    const result = await service.updateUser("user-123", { active: false });

    expect(result.active).toBe(false);
    expect(fbm.setCustomClaims).not.toHaveBeenCalled();
    expect(fbm.revokeFirebaseRefreshTokens).toHaveBeenCalledWith("user-123");
  });

  it("blocks self role/client/active changes (400 BAD_REQUEST)", async () => {
    dbm.getUserById.mockResolvedValue(makeSuperAdmin() as never);
    await expectHttp(
      () => service.updateUser("admin-123", { active: false }, "admin-123"),
      400,
      ErrorCodes.BAD_REQUEST,
    );
    expect(dbm.updateUser).not.toHaveBeenCalled();
  });

  it("blocks demoting/deactivating the last active super admin (400 BAD_REQUEST)", async () => {
    dbm.getUserById.mockResolvedValue(makeSuperAdmin({ active: true }) as never);
    dbm.countActiveSuperAdmins.mockResolvedValue(1);
    await expectHttp(
      () => service.updateUser("admin-123", { active: false }, "other-admin"),
      400,
      ErrorCodes.BAD_REQUEST,
    );
    expect(dbm.updateUser).not.toHaveBeenCalled();
    expect(fbm.setCustomClaims).not.toHaveBeenCalled();
  });

  it("throws 404 NOT_FOUND for a nonexistent user", async () => {
    dbm.getUserById.mockResolvedValue(undefined);
    await expectHttp(
      () => service.updateUser("nope", { name: "x" }),
      404,
      ErrorCodes.NOT_FOUND,
    );
  });

  it("throws 400 BAD_REQUEST for an invalid clientId", async () => {
    dbm.getUserById.mockResolvedValue(makeUser() as never);
    dbm.clientExists.mockResolvedValue(false);
    await expectHttp(
      () => service.updateUser("user-123", { clientId: "invalid" }),
      400,
      ErrorCodes.BAD_REQUEST,
    );
  });

  it("restores the original Firebase claims when the DB update fails", async () => {
    const existing = makeUser(); // CLIENT_ADMIN / client-123
    dbm.getUserById.mockResolvedValue(existing as never);
    fbm.setCustomClaims.mockResolvedValue(undefined);
    dbm.updateUser.mockRejectedValue(new Error("DB update failed"));

    await expect(
      service.updateUser("user-123", {
        role: UserRole.SUPER_ADMIN,
        clientId: null,
      }),
    ).rejects.toThrow("DB update failed");

    expect(fbm.setCustomClaims).toHaveBeenCalledTimes(2);
    expect(fbm.setCustomClaims).toHaveBeenNthCalledWith(2, "user-123", {
      role: existing.role,
      clientId: existing.clientId,
    });
  });
});

// ============================================================================
// Role/client consistency edge cases
// ============================================================================
describe("role/client consistency on update", () => {
  it("CLIENT_ADMIN -> SUPER_ADMIN clears clientId", async () => {
    const existing = makeUser();
    dbm.getUserById.mockResolvedValue(existing as never);
    fbm.setCustomClaims.mockResolvedValue(undefined);
    dbm.updateUser.mockResolvedValue({
      ...existing,
      role: UserRole.SUPER_ADMIN,
      clientId: null,
      client: null,
    } as never);

    const result = await service.updateUser("user-123", {
      role: UserRole.SUPER_ADMIN,
      clientId: null,
    });
    expect(result.clientId).toBeNull();
  });

  it("SUPER_ADMIN -> CLIENT_ADMIN requires a clientId (provided)", async () => {
    const existing = makeSuperAdmin();
    dbm.getUserById.mockResolvedValue(existing as never);
    dbm.clientExists.mockResolvedValue(true);
    // Demoting an active super admin is only allowed when others remain.
    dbm.countActiveSuperAdmins.mockResolvedValue(2);
    fbm.setCustomClaims.mockResolvedValue(undefined);
    dbm.updateUser.mockResolvedValue({
      ...existing,
      role: UserRole.CLIENT_ADMIN,
      clientId: "client-456",
      client: null,
    } as never);

    const result = await service.updateUser("admin-123", {
      role: UserRole.CLIENT_ADMIN,
      clientId: "client-456",
    });
    expect(result.role).toBe(UserRole.CLIENT_ADMIN);
  });

  it("role-only -> SUPER_ADMIN while a clientId is present => 400 VALIDATION_ERROR", async () => {
    dbm.getUserById.mockResolvedValue(makeUser() as never);
    await expectHttp(
      () => service.updateUser("user-123", { role: UserRole.SUPER_ADMIN }),
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
    expect(fbm.setCustomClaims).not.toHaveBeenCalled();
  });

  it("role-only -> CLIENT_ADMIN with no clientId => 400 VALIDATION_ERROR", async () => {
    dbm.getUserById.mockResolvedValue(makeSuperAdmin() as never);
    await expectHttp(
      () => service.updateUser("admin-123", { role: UserRole.CLIENT_ADMIN }),
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
    expect(fbm.setCustomClaims).not.toHaveBeenCalled();
  });
});

// ============================================================================
// listUsers
// ============================================================================
describe("listUsers", () => {
  it("returns default pagination meta", async () => {
    dbm.listUsers.mockResolvedValue({ data: [makeUser(), makeUser()], total: 2 } as never);
    const result = await service.listUsers({ page: 1, limit: 20 });

    expect(result.data).toHaveLength(2);
    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    });
    expect(dbm.listUsers).toHaveBeenCalledWith(
      { role: undefined, clientId: undefined, active: undefined, search: undefined },
      0,
      20,
    );
  });

  it("passes each filter through", async () => {
    dbm.listUsers.mockResolvedValue({ data: [], total: 0 } as never);
    await service.listUsers({
      page: 1,
      limit: 20,
      role: UserRole.CLIENT_ADMIN,
      clientId: "client-123",
      active: true,
      search: "test",
    });
    expect(dbm.listUsers).toHaveBeenCalledWith(
      {
        role: UserRole.CLIENT_ADMIN,
        clientId: "client-123",
        active: true,
        search: "test",
      },
      0,
      20,
    );
  });

  it("computes skip and meta for a middle page", async () => {
    dbm.listUsers.mockResolvedValue({
      data: Array.from({ length: 5 }, () => makeUser()),
      total: 25,
    } as never);
    const result = await service.listUsers({ page: 2, limit: 5 });

    expect(result.meta).toEqual({
      page: 2,
      limit: 5,
      total: 25,
      totalPages: 5,
      hasNext: true,
      hasPrev: true,
    });
    expect(dbm.listUsers).toHaveBeenCalledWith(expect.anything(), 5, 5);
  });

  it("handles an empty result set (totalPages 0)", async () => {
    dbm.listUsers.mockResolvedValue({ data: [], total: 0 } as never);
    const result = await service.listUsers({ page: 1, limit: 20 });
    expect(result.data).toHaveLength(0);
    expect(result.meta.total).toBe(0);
    expect(result.meta.totalPages).toBe(0);
    expect(result.meta.hasNext).toBe(false);
    expect(result.meta.hasPrev).toBe(false);
  });
});

// ============================================================================
// deleteUser
// ============================================================================
describe("deleteUser", () => {
  it("deletes from DB then Firebase (happy path)", async () => {
    dbm.deleteUser.mockResolvedValue({ ok: true, user: makeUser() } as never);
    fbm.revokeFirebaseRefreshTokens.mockResolvedValue(undefined);
    fbm.deleteFirebaseUser.mockResolvedValue(undefined);

    await service.deleteUser("user-123", "requester-id");

    expect(dbm.deleteUser).toHaveBeenCalledWith("user-123");
    expect(fbm.revokeFirebaseRefreshTokens).toHaveBeenCalledWith("user-123");
    expect(fbm.deleteFirebaseUser).toHaveBeenCalledWith("user-123");
  });

  it("blocks deleting your own account before any DB access (400 BAD_REQUEST)", async () => {
    await expectHttp(
      () => service.deleteUser("user-123", "user-123"),
      400,
      ErrorCodes.BAD_REQUEST,
    );
    expect(dbm.deleteUser).not.toHaveBeenCalled();
    expect(fbm.deleteFirebaseUser).not.toHaveBeenCalled();
  });

  it("throws 404 NOT_FOUND when the user does not exist", async () => {
    dbm.deleteUser.mockResolvedValue({ ok: false, reason: "not_found" } as never);
    await expectHttp(
      () => service.deleteUser("nope", "requester-id"),
      404,
      ErrorCodes.NOT_FOUND,
    );
    expect(fbm.deleteFirebaseUser).not.toHaveBeenCalled();
  });

  it("throws 400 BAD_REQUEST for the last super admin (no Firebase delete)", async () => {
    dbm.deleteUser.mockResolvedValue({
      ok: false,
      reason: "last_super_admin",
    } as never);
    await expectHttp(
      () => service.deleteUser("admin-123", "requester-id"),
      400,
      ErrorCodes.BAD_REQUEST,
    );
    expect(fbm.deleteFirebaseUser).not.toHaveBeenCalled();
  });

  it("deletes a super admin when others exist", async () => {
    dbm.deleteUser.mockResolvedValue({
      ok: true,
      user: makeSuperAdmin(),
    } as never);
    fbm.revokeFirebaseRefreshTokens.mockResolvedValue(undefined);
    fbm.deleteFirebaseUser.mockResolvedValue(undefined);

    await service.deleteUser("admin-123", "requester-id");

    expect(fbm.revokeFirebaseRefreshTokens).toHaveBeenCalledWith("admin-123");
    expect(fbm.deleteFirebaseUser).toHaveBeenCalledWith("admin-123");
  });

  it("swallows a Firebase-delete failure after the DB delete succeeded", async () => {
    dbm.deleteUser.mockResolvedValue({ ok: true, user: makeUser() } as never);
    fbm.revokeFirebaseRefreshTokens.mockResolvedValue(undefined);
    fbm.deleteFirebaseUser.mockRejectedValue(new Error("Firebase delete failed"));

    await expect(
      service.deleteUser("user-123", "requester-id"),
    ).resolves.toBeUndefined();
    expect(fbm.deleteFirebaseUser).toHaveBeenCalledWith("user-123");
  });
});
