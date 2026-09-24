import {
  Injectable,
  ServiceUnavailableException,
  type BeforeApplicationShutdown,
} from "@nestjs/common";
import {
  ErrorCodes,
  SHUTDOWN_APP_CLOSE_LEAD_MS,
  SHUTDOWN_FORCE_CLOSE_LEAD_MS,
} from "@app/contracts";
import type { FastifyReply } from "fastify";

/** Reconnect delay told to drained SSE clients: 1-5 s, jittered to spread the reconnect burst. */
export function jitteredReconnectMs(random: () => number = Math.random): number {
  return 1_000 + Math.floor(random() * 4_000);
}

/** Retry-After (seconds) for requests refused while the process drains. */
export const DRAINING_RETRY_AFTER_SECONDS = 5;

/** Closes one open stream after telling the client when to reconnect. */
export type StreamShutdown = (reconnectInMs: number) => void;

/**
 * Per-app shutdown state (one instance per Nest app, provided by CoreModule):
 *
 * - `draining` flips on SIGTERM (or at the latest in beforeApplicationShutdown).
 *   /health/ready then reports 503 and new SSE connections get 503 +
 *   Retry-After.
 * - Every long-lived stream registers here. beforeApplicationShutdown sends each
 *   one `event: shutdown` with a jittered reconnect delay and closes it. It runs
 *   BEFORE Nest closes Fastify; onApplicationShutdown only runs after the
 *   server has closed, which open streams would block indefinitely.
 */
@Injectable()
export class ShutdownCoordinator implements BeforeApplicationShutdown {
  private isDraining = false;
  private drained = false;
  private readonly streams = new Set<StreamShutdown>();

  get draining(): boolean {
    return this.isDraining;
  }

  startDraining(): void {
    this.isDraining = true;
  }

  /**
   * Track an open stream; returns the untrack function (call it on close). A
   * stream that finishes opening after the drain already ran (it passed
   * assertAcceptingStreams just before) is shut down on the next tick, once
   * its caller has finished setting it up.
   */
  trackStream(shutdown: StreamShutdown): () => void {
    if (this.drained) {
      setImmediate(() => {
        try {
          shutdown(jitteredReconnectMs());
        } catch {
          // best effort: the socket may already be gone
        }
      });
      return () => undefined;
    }
    this.streams.add(shutdown);
    return () => {
      this.streams.delete(shutdown);
    };
  }

  get openStreams(): number {
    return this.streams.size;
  }

  /** Refuse a new long-lived connection while draining: 503 + Retry-After. */
  assertAcceptingStreams(reply: FastifyReply): void {
    if (!this.isDraining) return;
    void reply.header("Retry-After", String(DRAINING_RETRY_AFTER_SECONDS));
    throw new ServiceUnavailableException({
      code: ErrorCodes.SERVER_SHUTTING_DOWN,
      message: "Server is restarting; reconnect shortly",
    });
  }

  /** Send every open stream `event: shutdown` and close it. */
  drainStreams(random: () => number = Math.random): number {
    this.drained = true;
    const streams = [...this.streams];
    this.streams.clear();
    for (const shutdown of streams) {
      try {
        shutdown(jitteredReconnectMs(random));
      } catch {
        // best effort: the socket may already be gone
      }
    }
    return streams.length;
  }

  beforeApplicationShutdown(): void {
    this.startDraining();
    this.drainStreams();
  }
}

interface ShutdownLogger {
  info(details: object, message: string): void;
  info(message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

export interface ShutdownSteps {
  /** SHUTDOWN_GRACE_MS: the process hard-exits when it runs out. */
  graceMs: number;
  /** Flip readiness and refuse new streams (ShutdownCoordinator.startDraining). */
  startDraining: () => void;
  /** app.close(): drains streams (beforeApplicationShutdown), closes Fastify, runs shutdown hooks. */
  closeApp: () => Promise<void>;
  /** Destroy sockets still open late in the grace period (server.closeAllConnections()). */
  forceCloseConnections: () => void;
  /** End the database pool; runs after closeApp settles or is abandoned. */
  closeDb: () => Promise<void>;
  exit: (code: number) => void;
  logger: ShutdownLogger;
}

/** When each fallback fires, in ms after the signal. */
export function shutdownTimeline(graceMs: number) {
  return {
    forceCloseAt: Math.max(0, graceMs - SHUTDOWN_FORCE_CLOSE_LEAD_MS),
    abandonAppCloseAt: Math.max(0, graceMs - SHUTDOWN_APP_CLOSE_LEAD_MS),
    hardExitAt: graceMs,
  };
}

/**
 * One graceful shutdown per process; later signals are ignored.
 *
 * 1. Start draining (readiness 503, new streams refused).
 * 2. app.close(): streams get `event: shutdown` and close, Fastify closes,
 *    Nest shutdown hooks run.
 * 3. At grace − 5 s, destroy any sockets still open so Fastify's close can finish.
 * 4. The pool closes once the app has closed, or at grace − 2 s if it has not.
 * 5. At grace, exit(1) whatever is still pending.
 */
export function createShutdownHandler(steps: ShutdownSteps): (signal: string) => Promise<void> {
  let shutdown: Promise<void> | undefined;

  const run = async (signal: string): Promise<void> => {
    const { graceMs, logger } = steps;
    const timeline = shutdownTimeline(graceMs);
    logger.info({ signal, graceMs }, "API shutting down");
    steps.startDraining();

    // Deliberately not unref'd: they must fire even if nothing else keeps the
    // event loop alive, and they are cleared on a clean finish.
    const forceTimer = setTimeout(() => {
      logger.warn({ afterMs: timeline.forceCloseAt }, "Force-closing open connections");
      try {
        steps.forceCloseConnections();
      } catch (err) {
        logger.error({ err }, "Force-closing connections failed");
      }
    }, timeline.forceCloseAt);
    const hardExitTimer = setTimeout(() => {
      logger.error({ graceMs }, "Shutdown grace period exhausted; exiting");
      steps.exit(1);
    }, timeline.hardExitAt);

    let exitCode = 0;
    let abandonTimer: NodeJS.Timeout | undefined;
    try {
      const abandoned = new Promise<"abandoned">((resolve) => {
        abandonTimer = setTimeout(() => resolve("abandoned"), timeline.abandonAppCloseAt);
      });
      const outcome = await Promise.race([
        steps.closeApp().then(() => "closed" as const),
        abandoned,
      ]);
      if (outcome === "abandoned") {
        exitCode = 1;
        logger.warn(
          { afterMs: timeline.abandonAppCloseAt },
          "API close still pending; closing the database pool anyway",
        );
      }
    } catch (err) {
      exitCode = 1;
      logger.error({ err }, "API close failed");
    } finally {
      clearTimeout(abandonTimer);
    }
    try {
      await steps.closeDb();
    } catch (err) {
      exitCode = 1;
      logger.error({ err }, "Database pool close failed");
    }
    clearTimeout(forceTimer);
    clearTimeout(hardExitTimer);
    logger.info({ exitCode }, "API stopped");
    steps.exit(exitCode);
  };

  return (signal: string) => {
    shutdown ??= run(signal);
    return shutdown;
  };
}
