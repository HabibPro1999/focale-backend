import { config } from "dotenv";
import { resolve } from "path";
import { beforeEach, vi } from "vitest";

// Load test environment variables
config({ path: resolve(process.cwd(), ".env.test") });

// Fallback to .env if .env.test doesn't exist
config({ path: resolve(process.cwd(), ".env") });

// Validate we're in test mode
if (process.env.NODE_ENV !== "test") {
  console.warn('Warning: NODE_ENV is not set to "test". Setting it now.');
  process.env.NODE_ENV = "test";
}

process.env.FIREBASE_STORAGE_BUCKET ??= "test-bucket";

// Import mocks - these set up vi.mock() calls
import "./mocks/prisma.js";
import "./mocks/firebase.js";
import "./mocks/sendgrid.js";

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Global test timeout
vi.setConfig({
  testTimeout: 10000,
  hookTimeout: 10000,
});
