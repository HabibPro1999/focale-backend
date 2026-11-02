import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Image HEALTHCHECK. APP=api or all: the API's /health/live (liveness, no I/O).
// APP=worker: the worker heartbeat file must have been touched recently (the
// worker also beats while idle with RUN_WORKERS=false).
//
// Defaults mirror packages/contracts/src/lifecycle.ts (a contracts test keeps
// them in sync).
const WORKER_HEARTBEAT_MAX_AGE_MS = 60_000;
const WORKER_HEARTBEAT_FILE_NAME = "focale-worker.heartbeat";
const LIVE_TIMEOUT_MS = 2_500;

export async function check(env = process.env) {
  const mode = env.APP || "api";
  if (mode === "worker") {
    const file = env.WORKER_HEARTBEAT_FILE?.trim() || join(tmpdir(), WORKER_HEARTBEAT_FILE_NAME);
    try {
      const { mtimeMs } = await stat(file);
      const ageMs = Date.now() - mtimeMs;
      return ageMs <= WORKER_HEARTBEAT_MAX_AGE_MS
        ? { ok: true }
        : { ok: false, reason: `worker heartbeat is ${Math.round(ageMs / 1000)} s old` };
    } catch {
      return { ok: false, reason: "worker heartbeat file missing" };
    }
  }
  const port = env.PORT?.trim() || "3000";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health/live`, {
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    return response.ok ? { ok: true } : { ok: false, reason: `/health/live returned ${response.status}` };
  } catch {
    return { ok: false, reason: "/health/live unreachable" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await check();
  if (!result.ok) console.error(`healthcheck failed: ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}
