import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const trace: string[] = [];
  const emailStatus = {
    listener: vi.fn(),
    flush: vi.fn(async () => {
      trace.push("flush");
    }),
  };
  const config = {
    DATABASE_URL: "postgresql://boot-characterization.invalid/test",
    database: { maxConnections: 3 },
    JSONB_VALIDATION: "enforce",
    integrations: { email: { provider: "test" } },
    realtime: { disabled: false },
    MIGRATIONS_CHECK: "enforce",
    lifecycle: { shutdownGraceMs: 3210 },
    PORT: 4321,
  };
  const schemaCheck = { current: true };
  const readiness = {
    recordSchemaCheck: vi.fn(() => {
      trace.push("readiness");
    }),
  };
  const coordinator = { startDraining: vi.fn() };
  const app = {
    get: vi.fn((token: { name: string }) =>
      token.name === "ReadinessService" ? readiness : coordinator,
    ),
    close: vi.fn(),
    getHttpServer: vi.fn(() => ({ closeAllConnections: vi.fn() })),
    listen: vi.fn(async () => {
      trace.push("listen");
    }),
  };
  return {
    trace,
    config,
    emailStatus,
    schemaCheck,
    readiness,
    coordinator,
    app,
    schemaError: undefined as Error | undefined,
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    shutdownOptions: undefined as
      | Parameters<typeof import("./core/shutdown").createShutdownHandler>[0]
      | undefined,
    shutdown: vi.fn(async () => undefined),
    logger: { error: vi.fn(), info: vi.fn() },
  };
});
const db = vi.hoisted(() => ({
  closeDb: vi.fn(async () => {
    state.trace.push("closeDb");
  }),
  assertSchemaCurrent: vi.fn(async () => {
    state.trace.push("schema");
    if (state.schemaError) throw state.schemaError;
    return state.schemaCheck;
  }),
}));
const integrations = vi.hoisted(() => ({
  configureRuntime: vi.fn(() => {
    state.trace.push("runtime");
    return state.emailStatus;
  }),
}));
vi.mock("@app/db", () => db);
vi.mock("@app/integrations", () => integrations);
vi.mock("./core/config", () => ({
  loadConfig: () => {
    state.trace.push("config");
    return state.config;
  },
}));
vi.mock("./core/logger.service", () => ({ logger: state.logger }));
vi.mock("./modules/health/readiness.service", () => ({
  ReadinessService: class ReadinessService {},
}));
vi.mock("./core/shutdown", () => ({
  ShutdownCoordinator: class ShutdownCoordinator {},
  createShutdownHandler: (options: typeof state.shutdownOptions) => {
    state.trace.push("shutdown");
    state.shutdownOptions = options;
    return state.shutdown;
  },
}));
vi.mock("./app.factory", () => ({
  buildApp: async () => {
    state.trace.push("app");
    return state.app;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.trace.length = 0;
  state.handlers.clear();
  state.config.realtime.disabled = false;
  state.schemaError = undefined;
  state.shutdownOptions = undefined;
  vi.spyOn(process, "on").mockImplementation((signal, handler) => {
    state.trace.push(String(signal));
    state.handlers.set(String(signal), handler);
    return process;
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

async function boot() {
  await import("./main.js");
}

describe("API bootstrap wiring", () => {
  it("configures the runtime first, records readiness, and flushes before closing the pool", async () => {
    await boot();
    await vi.waitFor(() => expect(state.app.listen).toHaveBeenCalled());
    expect(state.trace).toEqual([
      "unhandledRejection",
      "config",
      "runtime",
      "schema",
      "app",
      "readiness",
      "shutdown",
      "SIGTERM",
      "SIGINT",
      "listen",
    ]);
    expect(integrations.configureRuntime).toHaveBeenCalledWith(
      state.config,
      "focale-api",
    );
    expect(db.assertSchemaCurrent).toHaveBeenCalledWith({
      mode: "enforce",
      logger: state.logger,
    });
    expect(state.readiness.recordSchemaCheck).toHaveBeenCalledWith(
      state.schemaCheck,
    );
    expect(state.app.listen).toHaveBeenCalledWith({
      host: "0.0.0.0",
      port: 4321,
    });
    expect(state.shutdownOptions?.graceMs).toBe(3210);
    await state.shutdownOptions?.closeDb();
    expect(state.trace.slice(-2)).toEqual(["flush", "closeDb"]);
    state.handlers.get("SIGTERM")?.();
    expect(state.shutdown).toHaveBeenCalledWith("SIGTERM");
    const error = new Error("unhandled");
    state.handlers.get("unhandledRejection")?.(error);
    expect(state.logger.error).toHaveBeenCalledWith(
      { err: error },
      "Unhandled promise rejection",
    );
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("passes the realtime-disabled config through and still flushes before closing the pool", async () => {
    state.config.realtime.disabled = true;
    await boot();
    await vi.waitFor(() => expect(state.app.listen).toHaveBeenCalled());
    expect(integrations.configureRuntime).toHaveBeenCalledWith(
      state.config,
      "focale-api",
    );
    await state.shutdownOptions?.closeDb();
    expect(state.trace.slice(-2)).toEqual(["flush", "closeDb"]);
  });

  it("reports schema failure without building or listening", async () => {
    state.schemaError = new Error("stale schema");
    await boot();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(state.logger.error).toHaveBeenCalledWith(
      { err: state.schemaError },
      "Fatal boot error",
    );
    expect(state.trace).toEqual([
      "unhandledRejection",
      "config",
      "runtime",
      "schema",
    ]);
    expect(state.app.get).not.toHaveBeenCalled();
    expect(state.app.listen).not.toHaveBeenCalled();
    expect(state.handlers.has("SIGTERM")).toBe(false);
  });
});
