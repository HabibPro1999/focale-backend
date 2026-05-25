import { vi } from "vitest";
import { loadMigrationEnv } from "./helpers/test-env.js";

loadMigrationEnv();

vi.setConfig({
  testTimeout: 120000,
  hookTimeout: 30000,
});
