import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, parseAppConfig } from "./app-config";
import {
  SHUTDOWN_ESCALATION_MS,
  SHUTDOWN_GRACE_DEFAULT_MS,
  WORKER_HEARTBEAT_FILE_NAME,
  WORKER_HEARTBEAT_MAX_AGE_MS,
  defaultWorkerHeartbeatFile,
} from "./lifecycle";

const root = resolve(__dirname, "../../..");
const script = (name: string) => readFileSync(resolve(root, name), "utf-8");
const constant = (source: string, name: string) => {
  const match = new RegExp(`const ${name} = ([^;]+);`).exec(source);
  if (!match) throw new Error(`${name} not found`);
  return match[1]!.replace(/_/g, "").replace(/^"|"$/g, "");
};

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pass@localhost:26257/app",
    FIREBASE_PROJECT_ID: "demo-project",
    FIREBASE_STORAGE_BUCKET: "demo-bucket",
    ...overrides,
  };
}

describe("lifecycle config", () => {
  it("defaults the shutdown grace to 25 s and the heartbeat file to the OS temp dir", () => {
    const config = parseAppConfig(env());
    expect(config.lifecycle).toEqual({
      shutdownGraceMs: 25_000,
      workerHeartbeatFile: defaultWorkerHeartbeatFile(),
      serviceName: "focale-worker",
    });
    expect(parseAppConfig(env({ RENDER_SERVICE_NAME: "focale-worker-prod" })).lifecycle.serviceName).toBe(
      "focale-worker-prod",
    );
    expect(defaultWorkerHeartbeatFile()).toMatch(/focale-worker\.heartbeat$/);
  });

  it("accepts SHUTDOWN_GRACE_MS within 10-290 s and rejects anything else", () => {
    expect(parseAppConfig(env({ SHUTDOWN_GRACE_MS: "20000" })).lifecycle.shutdownGraceMs).toBe(20_000);
    for (const value of ["9999", "290001", "25s", "2.5e4", "-1"]) {
      expect(() => parseAppConfig(env({ SHUTDOWN_GRACE_MS: value })), value).toThrow(ConfigError);
    }
  });

  it("keeps the start-runtime.mjs and healthcheck.mjs defaults in sync", () => {
    const runtime = script("start-runtime.mjs");
    expect(Number(constant(runtime, "SHUTDOWN_GRACE_DEFAULT_MS"))).toBe(SHUTDOWN_GRACE_DEFAULT_MS);
    expect(Number(constant(runtime, "SHUTDOWN_ESCALATION_MS"))).toBe(SHUTDOWN_ESCALATION_MS);
    const healthcheck = script("healthcheck.mjs");
    expect(Number(constant(healthcheck, "WORKER_HEARTBEAT_MAX_AGE_MS"))).toBe(WORKER_HEARTBEAT_MAX_AGE_MS);
    expect(constant(healthcheck, "WORKER_HEARTBEAT_FILE_NAME")).toBe(WORKER_HEARTBEAT_FILE_NAME);
  });
});
