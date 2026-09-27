import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => {
  const order: string[] = [];
  const failure = new Error("boot stage failed");
  const state = {
    order, failure, failAt: "",
    config: { DATABASE_URL: "postgresql://unit/boot", database: { marker: "db" }, integrations: { marker: "integrations" }, MIGRATIONS_CHECK: "enforce", PORT: 3456, lifecycle: { shutdownGraceMs: 1234 } },
    listeners: new Map<string | symbol, (...args: unknown[]) => void>(),
    record(stage: string) { order.push(stage); if (state.failAt === stage) throw failure; },
    logger: { error: vi.fn(), info: vi.fn() },
    configureDb: vi.fn(), configureIntegrations: vi.fn(), listener: vi.fn(), emitEmailLogRealtimeEvent: vi.fn(),
    schema: vi.fn(), parse: vi.fn(), build: vi.fn(), listen: vi.fn(), closeDb: vi.fn(),
    shutdown: vi.fn(), createShutdown: vi.fn(), coordinator: { startDraining: vi.fn() },
    closeApp: vi.fn(), closeConnections: vi.fn(),
  };
  return state;
});
vi.mock("@app/contracts", () => ({ parseAppConfig: boot.parse }));
vi.mock("@app/db", () => ({ configureDb: boot.configureDb, assertSchemaCurrent: boot.schema, closeDb: boot.closeDb }));
vi.mock("../../../packages/integrations/src/config", () => ({ configureIntegrations: boot.configureIntegrations }));
vi.mock("../../../packages/integrations/src/email/queue", () => ({ setEmailStatusChangeListener: boot.listener, emitEmailLogRealtimeEvent: boot.emitEmailLogRealtimeEvent }));
vi.mock("@app/integrations", async () => ({
  ...await import("../../../packages/integrations/src/config"),
  ...await import("../../../packages/integrations/src/email/queue"),
}));
vi.mock("./app.factory", () => ({ buildApp: boot.build }));
vi.mock("./core/logger.service", () => ({ logger: boot.logger }));
vi.mock("./core/shutdown", () => ({ ShutdownCoordinator: class {}, createShutdownHandler: boot.createShutdown }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  boot.order.length = 0;
  boot.listeners.clear();
  boot.failAt = "";
  boot.parse.mockImplementation(() => { boot.record("parse"); return boot.config; });
  boot.configureDb.mockImplementation(() => boot.record("db"));
  boot.configureIntegrations.mockImplementation(() => boot.record("integrations"));
  boot.listener.mockImplementation(() => boot.record("listener"));
  boot.schema.mockImplementation(async () => boot.record("schema"));
  boot.build.mockImplementation(async () => {
    boot.record("build");
    return { get: () => boot.coordinator, listen: boot.listen, close: boot.closeApp, getHttpServer: () => ({ closeAllConnections: boot.closeConnections }) };
  });
  boot.listen.mockImplementation(async () => boot.record("listen"));
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

const successfulOrder = ["on:unhandledRejection", "parse", "db", "integrations", "listener", "schema", "build", "shutdown", "on:SIGTERM", "on:SIGINT", "listen", "info"];

it("pins boot order, API config identity, signal order and logging", async () => {
  await import("./main");
  await vi.waitFor(() => expect(boot.logger.info).toHaveBeenCalled());
  expect(boot.order).toEqual(successfulOrder);
  expect(boot.parse).toHaveBeenCalledWith(process.env);
  expect(boot.configureDb).toHaveBeenCalledWith({ applicationName: "focale-api", databaseUrl: boot.config.DATABASE_URL, settings: boot.config.database });
  expect(boot.configureIntegrations).toHaveBeenCalledWith(boot.config.integrations);
  expect(boot.listener).toHaveBeenCalledWith(boot.emitEmailLogRealtimeEvent);
  expect(boot.schema).toHaveBeenCalledWith({ mode: "enforce", logger: boot.logger });
  expect(boot.build).toHaveBeenCalledWith(boot.config);
  expect(boot.listen).toHaveBeenCalledWith({ host: "0.0.0.0", port: 3456 });
  expect(boot.logger.info).toHaveBeenCalledWith({ port: 3456 }, "API listening");
  const config = await import("./core/config");
  expect(config.loadConfig()).toBe(boot.config);
  expect(config.getConfig()).toBe(boot.config);
  expect(boot.parse).toHaveBeenCalledOnce();
  boot.listeners.get("SIGTERM")!();
  boot.listeners.get("SIGINT")!();
  expect(boot.shutdown.mock.calls).toEqual([["SIGTERM"], ["SIGINT"]]);
  const reason = new Error("unhandled fixture");
  boot.listeners.get("unhandledRejection")!(reason);
  expect(boot.logger.error).toHaveBeenCalledWith({ err: reason }, "Unhandled promise rejection");
  expect(process.exit).not.toHaveBeenCalled();
});

it.each(["parse", "db", "integrations", "listener", "schema"])("stops at a failed %s stage and retains fatal handling", async (stage) => {
  boot.failAt = stage;
  await import("./main");
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(boot.order).toEqual([...successfulOrder.slice(0, successfulOrder.indexOf(stage) + 1), "error", "exit:1"]);
  expect(boot.logger.error).toHaveBeenCalledWith({ err: boot.failure }, "Fatal boot error");
  expect(boot.build).not.toHaveBeenCalled();
});
