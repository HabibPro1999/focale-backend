/**
 * start-runtime.mjs (the image CMD) SIGKILLs its children 10 s after
 * forwarding SIGTERM (Render itself allows 30 s). Bound the app close below
 * that so the pool is still ended; plan item 3.2 raises both together.
 */
export const SHUTDOWN_APP_CLOSE_TIMEOUT_MS = 8_000;

interface ShutdownLogger {
  info(details: object, message: string): void;
  info(message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

export interface ShutdownSteps {
  /** Close the Nest app (HTTP server, lifecycle hooks). */
  closeApp: () => Promise<void>;
  /** End the database pool; runs after closeApp settles or times out. */
  closeDb: () => Promise<void>;
  exit: (code: number) => void;
  logger: ShutdownLogger;
  appCloseTimeoutMs?: number;
}

/**
 * One graceful shutdown per process: the first signal closes the app, then
 * the database pool, then exits; later signals are ignored. A hung app close
 * (for example open SSE streams, which are only drained after Fastify closes)
 * is bounded so the pool is still ended before the supervisor's SIGKILL.
 */
export function createShutdownHandler(steps: ShutdownSteps): (signal: string) => Promise<void> {
  let shutdown: Promise<void> | undefined;
  const timeoutMs = steps.appCloseTimeoutMs ?? SHUTDOWN_APP_CLOSE_TIMEOUT_MS;

  const run = async (signal: string): Promise<void> => {
    steps.logger.info({ signal }, "API shutting down");
    let exitCode = 0;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref();
      });
      const outcome = await Promise.race([steps.closeApp().then(() => "closed" as const), timedOut]);
      if (outcome === "timeout") {
        exitCode = 1;
        steps.logger.warn({ timeoutMs }, "API close timed out; closing the database pool anyway");
      }
    } catch (err) {
      exitCode = 1;
      steps.logger.error({ err }, "API close failed");
    } finally {
      clearTimeout(timer);
    }
    try {
      await steps.closeDb();
    } catch (err) {
      exitCode = 1;
      steps.logger.error({ err }, "Database pool close failed");
    }
    steps.logger.info("API stopped");
    steps.exit(exitCode);
  };

  return (signal: string) => {
    shutdown ??= run(signal);
    return shutdown;
  };
}
