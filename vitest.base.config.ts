import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const testExclude = ["**/node_modules/**", "**/dist/**"];

export const coverageConfig = {
  provider: "v8" as const,
  enabled: false,
  reporter: ["text", "json", "html", "lcov"],
  reportsDirectory: "./coverage",
  include: ["src/**/*.ts"],
  exclude: [
    "src/**/*.d.ts",
    "src/**/*.test.ts",
    "src/**/index.ts",
    "src/database/client.ts",
    "src/generated/**",
  ],
  thresholds: {
    lines: 80,
    functions: 80,
    branches: 75,
    statements: 80,
  },
};

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: testExclude,
    clearMocks: true,
    restoreMocks: true,
    coverage: coverageConfig,
    reporters: ["default"],
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@config": path.resolve(__dirname, "./src/config"),
      "@core": path.resolve(__dirname, "./src/core"),
      "@shared": path.resolve(__dirname, "./src/shared"),
      "@modules": path.resolve(__dirname, "./src/modules"),
      "@identity": path.resolve(
        __dirname,
        "./src/modules/identity/index.ts",
      ),
      "@clients": path.resolve(__dirname, "./src/modules/clients/index.ts"),
      "@events": path.resolve(__dirname, "./src/modules/events/index.ts"),
      "@forms": path.resolve(__dirname, "./src/modules/forms/index.ts"),
      "@pricing": path.resolve(__dirname, "./src/modules/pricing/index.ts"),
      "@access": path.resolve(__dirname, "./src/modules/access/index.ts"),
      "@registrations": path.resolve(
        __dirname,
        "./src/modules/registrations/index.ts",
      ),
      "@reports": path.resolve(__dirname, "./src/modules/reports/index.ts"),
      "@email": path.resolve(__dirname, "./src/modules/email/index.ts"),
      "@sponsorships": path.resolve(
        __dirname,
        "./src/modules/sponsorships/index.ts",
      ),
      "@certificates": path.resolve(
        __dirname,
        "./src/modules/certificates/index.ts",
      ),
      "@checkin": path.resolve(
        __dirname,
        "./src/modules/checkin/index.ts",
      ),
      "@realtime": path.resolve(
        __dirname,
        "./src/modules/realtime/index.ts",
      ),
      "@abstracts": path.resolve(
        __dirname,
        "./src/modules/abstracts/index.ts",
      ),
    },
  },
});
