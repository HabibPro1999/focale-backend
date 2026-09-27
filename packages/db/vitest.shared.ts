import type { UserConfig } from "vitest/config";

// @app/source first (workspace source). require/node before import so CJS-only deps resolve to their CJS entry.
const conditions = ["@app/source", "require", "node", "default"];

/** Worker cap for per-file databases; callers may lower it for CockroachDB. */
export function dbTestMaxWorkers(defaultValue = 2): number {
  const configured = process.env.TEST_DB_MAX_WORKERS;
  if (configured === undefined) return defaultValue;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new Error("TEST_DB_MAX_WORKERS must be an integer from 1 to 4.");
  }
  return value;
}

/** Migration hooks may need more headroom on the in-memory Cockroach service. */
export function dbTestSetupTimeoutMs(defaultValue = 120_000): number {
  const configured = process.env.TEST_DB_SETUP_TIMEOUT_MS;
  if (configured === undefined) return defaultValue;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 30_000 || value > 300_000) {
    throw new Error("TEST_DB_SETUP_TIMEOUT_MS must be an integer from 30000 to 300000.");
  }
  return value;
}

/** Shared resolve block for all four vitest tiers. */
export const resolveConditions = {
  resolve: { conditions },
  ssr: { resolve: { conditions } },
};

/** Fresh options for caller-owned SWC plugins; this module never loads SWC. */
export function swcDecoratorOptions() {
  return {
    module: { type: "es6" },
    jsc: {
      target: "es2022",
      parser: { syntax: "typescript", decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  } as const;
}

type UnitConfigOptions = {
  include: string[];
  exclude?: string[];
  setupFiles: string[];
  plugins?: UserConfig["plugins"];
};

export function unitConfig({ plugins, ...test }: UnitConfigOptions): UserConfig {
  return {
    ...resolveConditions,
    ...(plugins ? { plugins } : {}),
    test: { environment: "node", ...test },
  };
}

type DbTierConfigOptions = Omit<UnitConfigOptions, "exclude"> & {
  globalSetup?: string[];
  testTimeout: number;
  maxWorkersDefault?: number;
};

export function dbTierConfig({
  plugins,
  maxWorkersDefault = 2,
  ...test
}: DbTierConfigOptions): UserConfig {
  const maxWorkers = dbTestMaxWorkers(maxWorkersDefault);
  return {
    ...resolveConditions,
    ...(plugins ? { plugins } : {}),
    test: {
      environment: "node",
      ...test,
      hookTimeout: dbTestSetupTimeoutMs(),
      pool: "forks",
      fileParallelism: maxWorkers > 1,
      maxWorkers,
      minWorkers: 1,
    },
  };
}
