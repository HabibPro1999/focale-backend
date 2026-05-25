import { afterAll, beforeEach, vi } from "vitest";
import { loadDbEnv } from "./helpers/test-env.js";

loadDbEnv();

// Real-DB tiers keep Prisma real, but external network services remain mocked.
await import("./mocks/firebase.js");
await import("./mocks/sendgrid.js");

const { disconnectDatabase } = await import("./helpers/db.js");

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await disconnectDatabase();
});

vi.setConfig({
  testTimeout: 30000,
  hookTimeout: 30000,
});
