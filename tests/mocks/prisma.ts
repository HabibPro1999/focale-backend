import { beforeEach, vi } from 'vitest';
import { mockDeep, mockReset, type DeepMockProxy } from 'vitest-mock-extended';
import type { PrismaClient } from '@/generated/prisma/client.js';

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

// Mock the database client module. `getPool` is exported for graceful-shutdown
// hooks; return a stub that matches the real signature so integration harnesses
// that call pool cleanup don't blow up.
vi.mock('@/database/client.js', () => ({
  prisma: prismaMock,
  getPool: () => undefined,
}));

// Reset all mocks before each test
beforeEach(() => {
  mockReset(prismaMock);
  // Sensible defaults for raw queries used in shared helpers (e.g. reference number
  // generation). Tests can override via prismaMock.$queryRawUnsafe.mockResolvedValue(...).
  prismaMock.$queryRawUnsafe.mockResolvedValue([]);
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.$executeRawUnsafe.mockResolvedValue(0);
  prismaMock.$executeRaw.mockResolvedValue(0);
});

export type PrismaMock = DeepMockProxy<PrismaClient>;

/**
 * Set a mock return for Prisma's `groupBy` — its overload signature breaks
 * vitest-mock-extended's inferred `mockResolvedValue` typing. Use this helper
 * instead of casting at each call site.
 *
 * @example
 * mockGroupBy(prismaMock.registration.groupBy, []);
 * mockGroupBy(prismaMock.accessCheckIn.groupBy, [{ accessId: "a", _count: 1 }]);
 */
export function mockGroupBy<T>(method: unknown, value: T): void {
  (method as { mockResolvedValue: (v: T) => void }).mockResolvedValue(value);
}

import type { Mock } from 'vitest';

/**
 * Re-cast a Prisma `groupBy` mock to vitest's `Mock` surface so call sites
 * can use chained matchers (`.mockResolvedValueOnce`, `.mock.calls`) and
 * `.mockResolvedValue` directly. The overloaded Prisma signature otherwise
 * hides these from vitest-mock-extended's inferred types.
 */
export function asGroupByMock(method: unknown): Mock {
  return method as Mock;
}
