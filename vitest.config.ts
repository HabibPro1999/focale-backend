import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 10000,
    hookTimeout: 10000,

    // Parallel execution for speed
    pool: "forks",
    fileParallelism: true,

    // Clear mocks between tests
    clearMocks: true,
    restoreMocks: true,

    coverage: {
      provider: "v8",
      enabled: false, // Enable with --coverage flag
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/**/index.ts", // Barrel exports
        "src/database/client.ts", // Prisma client
        "src/generated/**", // Generated Prisma types
      ],

      // Coverage thresholds - fail CI if not met
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },

    // Reporter configuration
    reporters: ["default"],
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@config": path.resolve(__dirname, "./src/config"),
      "@core": path.resolve(__dirname, "./src/core"),
      "@shared": path.resolve(__dirname, "./src/shared"),
      "@modules": path.resolve(__dirname, "./src/modules"),
      "@identity": path.resolve(__dirname, "./src/modules/identity/index.ts"),
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
      "@checkin": path.resolve(__dirname, "./src/modules/checkin/index.ts"),
      "@realtime": path.resolve(__dirname, "./src/modules/realtime/index.ts"),
    },
  },
});
