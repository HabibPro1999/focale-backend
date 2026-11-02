import { tmpdir } from "node:os";
import { join } from "node:path";

// Process lifecycle constants shared by the API, the worker and the plain-JS
// supervisor/healthcheck scripts at the repo root (start-runtime.mjs,
// healthcheck.mjs), which repeat the defaults below (lifecycle.test.ts checks
// they stay in sync).

/** Default SHUTDOWN_GRACE_MS: under Render's 30 s SIGKILL with room for escalation. */
export const SHUTDOWN_GRACE_DEFAULT_MS = 25_000;
export const SHUTDOWN_GRACE_MIN_MS = 10_000;
export const SHUTDOWN_GRACE_MAX_MS = 290_000;
/** start-runtime.mjs SIGKILLs children this long after the grace period. */
export const SHUTDOWN_ESCALATION_MS = 3_000;
/** The API force-closes remaining sockets this long before the grace period ends. */
export const SHUTDOWN_FORCE_CLOSE_LEAD_MS = 5_000;
/** The API stops waiting for app.close() this long before the grace period ends (pool still closes). */
export const SHUTDOWN_APP_CLOSE_LEAD_MS = 2_000;

/** Worker heartbeat file, touched every WORKER_HEARTBEAT_INTERVAL_MS. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
/** The image HEALTHCHECK fails a worker whose heartbeat file is older than this. */
export const WORKER_HEARTBEAT_MAX_AGE_MS = 60_000;
export const WORKER_HEARTBEAT_FILE_NAME = "focale-worker.heartbeat";

export function defaultWorkerHeartbeatFile(): string {
  return join(tmpdir(), WORKER_HEARTBEAT_FILE_NAME);
}
