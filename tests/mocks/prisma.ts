import { beforeEach, vi } from "vitest";
import { mockDeep, mockReset, type DeepMockProxy } from "vitest-mock-extended";
import type { PrismaClient } from "@/generated/prisma/client.js";

/**
 * Deep mock of PrismaClient for unit testing.
 * This creates a fully mocked Prisma client where all methods return undefined by default.
 * Use mockResolvedValue/mockReturnValue to set expected returns.
 *
 * @example
 * prismaMock.client.create.mockResolvedValue(mockClient);
 * prismaMock.user.findUnique.mockResolvedValue(mockUser);
 */
export const prismaMock = mockDeep<PrismaClient>();

// Mock the database client module
vi.mock("@/database/client.js", () => ({
  prisma: prismaMock,
}));

// Reset all mocks before each test
beforeEach(() => {
  mockReset(prismaMock);
  // Support interactive transactions — callback receives the mock client as tx
  prismaMock.$transaction.mockImplementation(async (fn: unknown) => {
    if (typeof fn === "function") {
      return fn(prismaMock);
    }
    return Promise.all(fn as Promise<unknown>[]);
  });
});

export type PrismaMock = DeepMockProxy<PrismaClient>;
