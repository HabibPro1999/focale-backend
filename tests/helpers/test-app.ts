import { buildServer } from "../../src/core/server.js";
import type { AppInstance } from "../../src/shared/fastify.js";
import type { User } from "../../src/generated/prisma/client.js";

// ============================================================================
// Test App Creation
// ============================================================================

/**
 * Create a test Fastify instance.
 */
export async function createTestApp(): Promise<AppInstance> {
  const app = await buildServer();
  await app.ready();
  return app;
}

// ============================================================================
// Auth Helpers for Integration Tests
// ============================================================================

/**
 * Create authorization headers for a user.
 * Note: For integration tests, you need to mock Firebase token verification.
 */
export function createAuthHeaders(user: User): Record<string, string> {
  return {
    authorization: `Bearer mock-token-${user.id}`,
  };
}
