import { vi } from "vitest";
import { getUserWithClientById, type ClientRow, type UserWithClient } from "@app/db";
import { clearUserCache } from "../core/auth/user-cache";

/** Deterministic auth row; supply client/row overrides for route-specific fixtures. */
export function dbUser(
  role: number,
  clientId: string | null = null,
  overrides: Partial<UserWithClient> = {},
): UserWithClient {
  const date = new Date("2024-01-01T00:00:00Z");
  const client: ClientRow | null = clientId === null ? null : {
    id: clientId,
    name: "Test client",
    logo: null,
    primaryColor: null,
    email: null,
    phone: null,
    active: true,
    enabledModules: [],
    createdAt: date,
    updatedAt: date,
  };
  return {
    id: "u1",
    email: "u1@example.com",
    name: "User One",
    role,
    clientId,
    active: true,
    createdAt: date,
    updatedAt: date,
    client,
    ...overrides,
  };
}

/**
 * Keep the real AuthGuard. The test mocks getUserWithClientById and verifyToken
 * (returning the fixture's uid, "u1" by default). Call after resetting mocks or
 * when switching users; clears the cache and returns the bearer header.
 */
export function authAs(
  role: number,
  clientId: string | null = null,
  overrides: Partial<UserWithClient> = {},
): { authorization: string } {
  clearUserCache();
  vi.mocked(getUserWithClientById).mockResolvedValue(dbUser(role, clientId, overrides));
  return { authorization: "Bearer test" };
}
