import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Lifecycle = typeof import("./core/lifecycle");

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
    runWorkers: true,
    lifecycle: {
      shutdownGraceMs: 3210,
      serviceName: "test-worker",
      workerHeartbeatFile: "/unused/test-heartbeat",
    },
  };
  const runner = {
    start: vi.fn(() => {
      trace.push("runner.start");
    }),
    stop: vi.fn(),
    snapshot: vi.fn(() => []),
  };
  const ctx = { get: vi.fn(() => runner), close: vi.fn() };
  const heartbeat = {
    start: vi.fn(() => {
      trace.push("heartbeat.start");
    }),
  };
  return {
    trace,
    config,
    emailStatus,
    runner,
    ctx,
    heartbeat,
    schemaError: undefined as Error | undefined,
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    shutdownOptions: undefined as
      | Parameters<Lifecycle["createWorkerShutdown"]>[0]
      | undefined,
    heartbeatOptions: undefined as
      | ConstructorParameters<Lifecycle["WorkerHeartbeat"]>[0]
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
  }),
  getDb: vi.fn(() => "pool"),
  recordWorkerHeartbeat: vi.fn(),
  pruneWorkerHeartbeats: vi.fn(),
}));
const integrations = vi.hoisted(() => ({
  configureRuntime: vi.fn(() => {
    state.trace.push("runtime");
    return state.emailStatus;
  }),
}));
vi.mock("@app/db", () => db);
vi.mock("@app/integrations", () => integrations);
vi.mock("@app/shared", () => ({
  createLogger: () => state.logger,
  makeWorkerId: () => {
    state.trace.push("workerId");
    return "worker-123";
  },
}));
vi.mock("./core/config", () => ({
  loadConfig: () => {
    state.trace.push("config");
    return state.config;
  },
}));
vi.mock("./worker.module", () => ({ WorkerModule: class WorkerModule {} }));
vi.mock("./job-runner", () => ({ JobRunner: class JobRunner {} }));
vi.mock("@nestjs/core", () => ({
  NestFactory: {
    createApplicationContext: vi.fn(async () => {
      state.trace.push("context");
      return state.ctx;
    }),
  },
}));
vi.mock("./core/lifecycle", () => ({
  WorkerHeartbeat: class {
    constructor(options: typeof state.heartbeatOptions) {
      state.trace.push("heartbeat");
      state.heartbeatOptions = options;
    }
    start = state.heartbeat.start;
  },
  createWorkerShutdown: (options: typeof state.shutdownOptions) => {
    state.trace.push("shutdown");
    state.shutdownOptions = options;
    return state.shutdown;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.trace.length = 0;
  state.handlers.clear();
  state.config.realtime.disabled = false;
  state.config.runWorkers = true;
  state.schemaError = undefined;
  state.shutdownOptions = undefined;
  state.heartbeatOptions = undefined;
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

describe("worker bootstrap wiring", () => {
  it("configures runtime before schema/context and starts one runner and heartbeat", async () => {
    await boot();
    await vi.waitFor(() => expect(state.handlers.has("SIGTERM")).toBe(true));
    expect(state.trace).toEqual([
      "unhandledRejection",
      "config",
      "runtime",
      "workerId",
      "heartbeat",
      "schema",
      "context",
      "runner.start",
      "heartbeat.start",
      "shutdown",
      "SIGINT",
      "SIGTERM",
    ]);
    expect(integrations.configureRuntime).toHaveBeenCalledWith(
      state.config,
      "focale-worker",
    );
    expect(db.assertSchemaCurrent).toHaveBeenCalledWith({
      mode: "enforce",
      logger: state.logger,
    });
    expect(state.heartbeat.start).toHaveBeenCalledWith({
      disabled: false,
      jobs: expect.any(Function),
    });
    expect(state.shutdownOptions?.graceMs).toBe(3210);
    await state.shutdownOptions?.closeDb();
    expect(state.trace.slice(-2)).toEqual(["flush", "closeDb"]);
    await state.shutdownOptions?.closeContext?.();
    expect(state.ctx.close).toHaveBeenCalledOnce();
    await state.shutdownOptions?.stopRunner?.(123);
    expect(state.runner.stop).toHaveBeenCalledWith({ deadline: 123 });
    state.handlers.get("SIGINT")?.();
    expect(state.shutdown).toHaveBeenCalledWith("SIGINT");
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("configures runtime but skips schema and Nest when workers and realtime are disabled", async () => {
    state.config.runWorkers = false;
    state.config.realtime.disabled = true;
    await boot();
    await vi.waitFor(() => expect(state.handlers.has("SIGTERM")).toBe(true));
    expect(state.trace).toEqual([
      "unhandledRejection",
      "config",
      "runtime",
      "workerId",
      "heartbeat",
      "heartbeat.start",
      "shutdown",
      "SIGINT",
      "SIGTERM",
    ]);
    expect(integrations.configureRuntime).toHaveBeenCalledWith(
      state.config,
      "focale-worker",
    );
    expect(db.assertSchemaCurrent).not.toHaveBeenCalled();
    expect(state.ctx.get).not.toHaveBeenCalled();
    expect(state.heartbeat.start).toHaveBeenCalledWith({ disabled: true });
    expect(state.shutdownOptions?.stopRunner).toBeUndefined();
    expect(state.shutdownOptions?.closeContext).toBeUndefined();
    await state.shutdownOptions?.closeDb();
    expect(state.trace.slice(-2)).toEqual(["flush", "closeDb"]);
    await state.heartbeatOptions?.record?.({ disabled: true, jobs: {} });
    expect(db.recordWorkerHeartbeat).toHaveBeenCalledWith(
      {
        workerId: "worker-123",
        service: "test-worker",
        disabled: true,
        jobs: {},
      },
      "pool",
    );
    await state.heartbeatOptions?.prune?.();
    expect(db.pruneWorkerHeartbeats).toHaveBeenCalledWith("pool");
  });

  it("reports schema failure before starting the context or heartbeat", async () => {
    state.schemaError = new Error("stale schema");
    await boot();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(state.logger.error).toHaveBeenCalledWith(
      { err: state.schemaError },
      "worker fatal boot error",
    );
    expect(state.ctx.get).not.toHaveBeenCalled();
    expect(state.heartbeat.start).not.toHaveBeenCalled();
    expect(state.handlers.has("SIGTERM")).toBe(false);
  });
});
