// Vitest settings shared by every package config in apps/ and packages/. It
// sits beside the package directories, not inside one, so each config can
// import it by relative path without crossing the package layers. Keep it
// dependency-free: every package brings its own vitest, and the API and worker
// bring their own unplugin-swc.

// @app/source first (workspace source). require/node before import so CJS-only
// deps like pg resolve to their CJS entry, not an ESM shim.
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

// SWC so decorator metadata (design:paramtypes) exists in tests — mirrors
// dev/build. Returns a fresh object for each plugin instance.
export function swcDecoratorOptions() {
  return {
    module: { type: "es6" as const },
    jsc: {
      target: "es2022" as const,
      parser: { syntax: "typescript" as const, decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  };
}

interface TestFiles {
  include: string[];
  exclude?: string[];
  setupFiles: string[];
}

export function unitConfig(files: TestFiles) {
  return {
    resolve: { conditions },
    ssr: { resolve: { conditions } },
    test: { environment: "node" as const, ...files },
  };
}

interface DbTierOptions extends TestFiles {
  globalSetup?: string[];
  testTimeout: number;
  /** Worker cap when TEST_DB_MAX_WORKERS is unset (default 2). */
  maxWorkersDefault?: number;
}

/** Real-database tiers: forked workers, one disposable database per file. */
export function dbTierConfig({ maxWorkersDefault, ...test }: DbTierOptions) {
  const maxWorkers = dbTestMaxWorkers(maxWorkersDefault);
  return {
    resolve: { conditions },
    ssr: { resolve: { conditions } },
    test: {
      environment: "node" as const,
      ...test,
      hookTimeout: dbTestSetupTimeoutMs(),
      pool: "forks" as const,
      fileParallelism: maxWorkers > 1,
      maxWorkers,
      minWorkers: 1,
    },
  };
}
