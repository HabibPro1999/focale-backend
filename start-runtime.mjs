import { spawn } from "node:child_process";

// The same image supports separate services or one supervised API + worker.
const mode = process.env.APP || "api";
if (!["api", "worker", "all"].includes(mode)) {
  console.error("APP must be api, worker or all");
  process.exit(1);
}
const apps = mode === "all" ? ["api", "worker"] : [mode];
const children = new Set();
let stopping = false;
let exitCode = 0;
let timeout;

function stop(code, signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) child.kill(signal);
  timeout = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 10_000);
  timeout.unref();
}

for (const app of apps) {
  const child = spawn(process.execPath, [`apps/${app}/dist/main.js`], {
    stdio: "inherit",
    env: process.env,
  });
  children.add(child);
  child.on("error", (error) => {
    console.error(`${app} failed to start`, error);
    stop(1);
  });
  child.on("close", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${app} exited unexpectedly`, { code, signal });
      stop(code || 1);
    }
    if (children.size === 0) {
      clearTimeout(timeout);
      process.exit(exitCode);
    }
  });
}

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0, "SIGINT"));
