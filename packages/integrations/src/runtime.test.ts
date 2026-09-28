import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppConfig } from "@app/contracts";

const state = vi.hoisted(() => {
  const trace: string[] = [];
  return {
    trace,
    emailStatus: { listener: vi.fn(), flush: vi.fn(async () => undefined) },
    configureDb: vi.fn(() => {
      trace.push("db");
    }),
    configureIntegrations: vi.fn(() => {
      trace.push("integrations");
    }),
    configureOutbox: vi.fn(() => {
      trace.push("outbox");
    }),
    setEmailStatusChangeListener: vi.fn(() => {
      trace.push("listener");
    }),
    emitEmailLogRealtimeEvents: vi.fn(),
  };
});
const coalesce = vi.hoisted(() =>
  vi.fn(() => {
    state.trace.push("coalescer");
    return state.emailStatus;
  }),
);
vi.mock("@app/db", () => ({
  configureDb: state.configureDb,
  configureOutbox: state.configureOutbox,
}));
vi.mock("./config", () => ({
  configureIntegrations: state.configureIntegrations,
}));
vi.mock("./email/queue", () => ({
  setEmailStatusChangeListener: state.setEmailStatusChangeListener,
}));
vi.mock("./email/status-coalescer", () => ({
  coalesceEmailStatusChanges: coalesce,
  emitEmailLogRealtimeEvents: state.emitEmailLogRealtimeEvents,
}));

import { configureRuntime } from "./runtime";

function config(disabled: boolean) {
  return parseAppConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://boot-characterization.invalid/test",
    FIREBASE_PROJECT_ID: "test",
    FIREBASE_STORAGE_BUCKET: "test",
    REALTIME_DISABLED: String(disabled),
    JSONB_VALIDATION: "enforce",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.trace.length = 0;
});

describe("configureRuntime", () => {
  it.each([false, true])(
    "configures in order and returns the flush handle (realtime disabled: %s)",
    (disabled) => {
      const parsed = config(disabled);

      const handle = configureRuntime(parsed, "test-process");

      expect(state.trace).toEqual([
        "db",
        "integrations",
        "outbox",
        "coalescer",
        ...(disabled ? [] : ["listener"]),
      ]);
      expect(state.configureDb).toHaveBeenCalledWith({
        applicationName: "test-process",
        databaseUrl: parsed.DATABASE_URL,
        settings: parsed.database,
        jsonbValidation: "enforce",
      });
      expect(state.configureIntegrations).toHaveBeenCalledWith(
        parsed.integrations,
      );
      expect(state.configureOutbox).toHaveBeenCalledWith({
        realtimeDisabled: disabled,
      });
      expect(coalesce).toHaveBeenCalledWith(state.emitEmailLogRealtimeEvents);
      expect(handle).toBe(state.emailStatus);
      if (disabled) {
        expect(state.setEmailStatusChangeListener).not.toHaveBeenCalled();
      } else {
        expect(state.setEmailStatusChangeListener).toHaveBeenCalledWith(
          state.emailStatus.listener,
        );
      }
    },
  );

  it("propagates configuration failures before later setup steps", () => {
    const error = new Error("database config failed");
    state.configureDb.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => configureRuntime(config(false), "test-process")).toThrow(
      error,
    );
    expect(state.configureIntegrations).not.toHaveBeenCalled();
    expect(state.configureOutbox).not.toHaveBeenCalled();
    expect(coalesce).not.toHaveBeenCalled();
  });
});
