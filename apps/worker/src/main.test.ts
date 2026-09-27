import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => {
  const order: string[] = [];
  const failure = new Error("boot stage failed");
  const state = {
    order, failure, failAt: "",
    config: { DATABASE_URL: "postgresql://unit/boot", database: { marker: "db" }, integrations: { marker: "integrations" }, MIGRATIONS_CHECK: "enforce", runWorkers: true, lifecycle: { workerHeartbeatFile: "/unit/heartbeat", shutdownGraceMs: 1234 } },
    listeners: new Map<string | symbol, (...args: unknown[]) => void>(),
    record(stage: string) { order.push(stage); if (state.failAt === stage) throw failure; },
    logger: { error: vi.fn(), info: vi.fn() }, createLogger: vi.fn(),
    configureDb: vi.fn(), configureIntegrations: vi.fn(), listener: vi.fn(), emitEmailLogRealtimeEvent: vi.fn(),
    schema: vi.fn(), parse: vi.fn(), createContext: vi.fn(), closeDb: vi.fn(),
    shutdown: vi.fn(), createShutdown: vi.fn(), heartbeat: vi.fn(), heartbeatStart: vi.fn(),
    runner: { start: vi.fn(), stop: vi.fn() }, closeContext: vi.fn(),
  };
  return state;
});
vi.mock("@app/contracts", () => ({ parseAppConfig: boot.parse }));
vi.mock("@app/db", () => ({ configureDb: boot.configureDb, assertSchemaCurrent: boot.schema, closeDb: boot.closeDb }));
vi.mock("@app/shared", () => ({ createLogger: boot.createLogger }));
vi.mock("../../../packages/integrations/src/config", () => ({ configureIntegrations: boot.configureIntegrations }));
vi.mock("../../../packages/integrations/src/email/queue", () => ({ setEmailStatusChangeListener: boot.listener, emitEmailLogRealtimeEvent: boot.emitEmailLogRealtimeEvent }));
vi.mock("@app/integrations", async () => ({
  ...await import("../../../packages/integrations/src/runtime.js"),
  ...await import("../../../packages/integrations/src/config.js"),
  ...await import("../../../packages/integrations/src/email/queue.js"),
}));
vi.mock("@nestjs/core", () => ({ NestFactory: { createApplicationContext: boot.createContext } }));
vi.mock("./worker.module", () => ({ WorkerModule: class {} }));
vi.mock("./job-runner", () => ({ JobRunner: class {} }));
vi.mock("./core/lifecycle", () => ({
  WorkerHeartbeat: class {
    constructor(path: string, logger: unknown) { boot.heartbeat(path, logger); boot.record("heartbeat"); }
    start(options: { disabled: boolean }) { boot.heartbeatStart(options); boot.record(`heartbeat:${options.disabled}`); }
  },
  createWorkerShutdown: boot.createShutdown,
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  boot.order.length = 0;
  boot.listeners.clear();
  boot.failAt = "";
  boot.config.runWorkers = true;
  boot.createLogger.mockImplementation(() => { boot.record("logger"); return boot.logger; });
  boot.parse.mockImplementation(() => { boot.record("parse"); return boot.config; });
  boot.configureDb.mockImplementation(() => boot.record("db"));
  boot.configureIntegrations.mockImplementation(() => boot.record("integrations"));
  boot.listener.mockImplementation(() => boot.record("listener"));
  boot.schema.mockImplementation(async () => boot.record("schema"));
  boot.createContext.mockImplementation(async () => { boot.record("context"); return { get: () => boot.runner, close: boot.closeContext }; });
  boot.runner.start.mockImplementation(() => boot.record("runner"));
  boot.createShutdown.mockImplementation(() => { boot.record("shutdown"); return boot.shutdown; });
  boot.logger.info.mockImplementation(() => boot.record("info"));
  boot.logger.error.mockImplementation(() => boot.record("error"));
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    boot.record(`on:${String(event)}`);
    boot.listeners.set(event, listener);
    return process;
  });
  vi.spyOn(process, "exit").mockImplementation((code) => { boot.record(`exit:${code}`); return undefined as never; });
});
afterEach(() => vi.restoreAllMocks());

const successfulOrder = ["logger", "on:unhandledRejection", "parse", "db", "integrations", "listener", "heartbeat", "schema", "context", "runner", "heartbeat:false", "info", "shutdown", "on:SIGINT", "on:SIGTERM"];

it("pins enabled worker boot order, process identity and signal handling", async () => {
  await import("./main.js");
  await vi.waitFor(() => expect(boot.listeners.has("SIGTERM")).toBe(true));
  expect(boot.order).toEqual(successfulOrder);
  expect(boot.createLogger).toHaveBeenCalledWith({ name: "worker" });
  expect(boot.parse).toHaveBeenCalledExactlyOnceWith(process.env);
  expect(boot.configureDb).toHaveBeenCalledWith({ applicationName: "focale-worker", databaseUrl: boot.config.DATABASE_URL, settings: boot.config.database });
  expect(boot.configureIntegrations).toHaveBeenCalledWith(boot.config.integrations);
  expect(boot.listener).toHaveBeenCalledWith(boot.emitEmailLogRealtimeEvent);
  expect(boot.schema).toHaveBeenCalledWith({ mode: "enforce", logger: boot.logger });
  expect(boot.heartbeat).toHaveBeenCalledWith("/unit/heartbeat", boot.logger);
  expect(boot.heartbeatStart).toHaveBeenCalledWith({ disabled: false });
  expect(boot.logger.info).toHaveBeenCalledWith("worker started");
  boot.listeners.get("SIGINT")!();
  boot.listeners.get("SIGTERM")!();
  expect(boot.shutdown.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);
  const reason = new Error("unhandled fixture");
  boot.listeners.get("unhandledRejection")!(reason);
  expect(boot.logger.error).toHaveBeenCalledWith({ err: reason }, "Unhandled promise rejection");
  expect(process.exit).not.toHaveBeenCalled();
});

it("keeps disabled heartbeat and signal wiring while skipping schema and Nest", async () => {
  boot.config.runWorkers = false;
  await import("./main.js");
  expect(boot.order).toEqual(["logger", "on:unhandledRejection", "parse", "db", "integrations", "listener", "heartbeat", "info", "heartbeat:true", "shutdown", "on:SIGINT", "on:SIGTERM"]);
  expect(boot.heartbeatStart).toHaveBeenCalledWith({ disabled: true });
  expect(boot.logger.info).toHaveBeenCalledWith("RUN_WORKERS=false; jobs disabled, worker idling with a disabled heartbeat");
  expect(boot.schema).not.toHaveBeenCalled();
  expect(boot.createContext).not.toHaveBeenCalled();
  expect(boot.runner.start).not.toHaveBeenCalled();
  expect(boot.createShutdown.mock.calls[0]![0]).not.toHaveProperty("stopRunner");
  expect(boot.createShutdown.mock.calls[0]![0]).not.toHaveProperty("closeContext");
  expect(process.exit).not.toHaveBeenCalled();
});

it.each(["parse", "db", "integrations", "listener", "schema"])("stops at a failed %s stage and retains worker fatal handling", async (stage) => {
  boot.failAt = stage;
  await import("./main.js");
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(boot.order).toEqual([...successfulOrder.slice(0, successfulOrder.indexOf(stage) + 1), "error", "exit:1"]);
  expect(boot.logger.error).toHaveBeenCalledWith({ err: boot.failure }, "worker fatal boot error");
  expect(boot.createContext).not.toHaveBeenCalled();
});
