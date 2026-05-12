import { beforeEach, vi } from "vitest";
import { loadUnitEnv } from "./helpers/test-env.js";

loadUnitEnv();

// Import mocks after the isolated test environment is in place.
await import("./mocks/prisma.js");
await import("./mocks/firebase.js");
await import("./mocks/sendgrid.js");

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Global test timeout
vi.setConfig({
  testTimeout: 10000,
  hookTimeout: 10000,
});
