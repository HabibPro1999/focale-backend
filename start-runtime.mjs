import { spawn } from "node:child_process";

// Image CMD: supervises the API, the worker, or both (APP=all) in one container.
//
// Shutdown: SIGTERM/SIGINT is forwarded to every child. Each child drains and
// hard-exits within SHUTDOWN_GRACE_MS; any child still running
// SHUTDOWN_ESCALATION_MS after that is SIGKILLed. Keep grace + escalation below
// the platform's own SIGKILL delay (Render maxShutdownDelaySeconds).
//
// Defaults mirror packages/contracts/src/lifecycle.ts (a contracts test keeps
// them in sync); the apps validate SHUTDOWN_GRACE_MS strictly at boot.
const SHUTDOWN_GRACE_DEFAULT_MS = 25_000;
const SHUTDOWN_ESCALATION_MS = 3_000;

const mode = process.env.APP || "api";
if (!["api", "worker", "all"].includes(mode)) {
  console.error("APP must be api, worker or all");
  process.exit(1);
}

const rawGrace = process.env.SHUTDOWN_GRACE_MS?.trim();
const graceMs = rawGrace && /^\d+$/.test(rawGrace) ? Number(rawGrace) : SHUTDOWN_GRACE_DEFAULT_MS;
const escalateAfterMs = graceMs + SHUTDOWN_ESCALATION_MS;

// RUN_WORKERS=false with APP=all: run only the API (no idle worker process).
const workersDisabled = process.env.RUN_WORKERS === "false";
const apps =
  mode === "all" ? (workersDisabled ? ["api"] : ["api", "worker"]) : [mode];
if (mode === "all" && workersDisabled) {
  console.log("RUN_WORKERS=false: starting the API only");
}

const children = new Set();
let stopping = false;
let exitCode = 0;
let escalation;

function stop(code, signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) child.kill(signal);
  escalation = setTimeout(() => {
    for (const child of children) {
      console.error(`${child.appName} still running ${escalateAfterMs} ms after ${signal}; sending SIGKILL`);
      child.kill("SIGKILL");
    }
  }, escalateAfterMs);
  escalation.unref();
}

for (const app of apps) {
  const child = spawn(process.execPath, [`apps/${app}/dist/main.js`], {
    stdio: "inherit",
    env: process.env,
  });
  child.appName = app;
  children.add(child);
  child.on("error", (error) => {
    console.error(`${app} failed to start`, error);
    stop(1);
  });
  child.on("close", (code, signal) => {
    children.delete(child);
    if (stopping) {
      console.log(`${app} exited`, { code, signal });
    } else {
      console.error(`${app} exited unexpectedly`, { code, signal });
      stop(code || 1);
    }
    if (children.size === 0) {
      clearTimeout(escalation);
      process.exit(exitCode);
    }
  });
}

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0, "SIGINT"));
