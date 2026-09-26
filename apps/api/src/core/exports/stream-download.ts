import { Inject, Injectable } from "@nestjs/common";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import type { FastifyReply } from "fastify";
import { ErrorCodes, SHUTDOWN_FORCE_CLOSE_LEAD_MS } from "@app/contracts";
import { AppException } from "../app-exception";
import { CONFIG, type Config } from "../config";
import { logger } from "../logger.service";
import { ShutdownCoordinator } from "../shutdown";
import { ExportAbortedError, type ExportDownload } from "./stream-io";

// =============================================================================
// STREAMED FILE DOWNLOADS
// Every file export runs through ExportDownloads.stream(): a bounded number of
// exports at once (ExportLimiter), the file written straight into the response
// (no whole-file buffer, no Content-Length), generation stopped when the client
// goes away, and open downloads registered with the shutdown coordinator.
// =============================================================================

/** Retry-After (seconds) sent with 503 EXPORT_BUSY. */
export const EXPORT_BUSY_RETRY_AFTER_SECONDS = 10;

/** Longest a request waits in the export queue before 503 EXPORT_BUSY. */
export const EXPORT_QUEUE_WAIT_MS = 30_000;

/** Bytes buffered between the file generator and the socket before it pauses. */
export const EXPORT_STREAM_HIGH_WATER_MARK = 1024 * 1024;

/** Every export slot and queue place is taken (or the queue wait ran out). */
export class ExportBusyError extends Error {
  constructor(message = "Export capacity exhausted") {
    super(message);
    this.name = "ExportBusyError";
  }
}

export interface ExportLimiterOptions {
  maxConcurrent: number;
  maxQueued: number;
  queueWaitMs: number;
}

interface Waiter {
  grant: (release: () => void) => void;
  fail: (error: unknown) => void;
}

/**
 * Admission control for exports: `maxConcurrent` run at once, up to
 * `maxQueued` more wait in FIFO order. A request that finds the queue full, or
 * waits longer than `queueWaitMs`, fails with ExportBusyError; one whose
 * signal aborts while queued leaves the queue. A released slot passes straight
 * to the oldest waiter.
 */
export class ExportLimiter {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(private readonly options: ExportLimiterOptions) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** Resolves with the slot's release function (idempotent). */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    if (this.waiting.length >= this.options.maxQueued) {
      return Promise.reject(new ExportBusyError("Export queue is full"));
    }
    return new Promise<() => void>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
      };
      const waiter: Waiter = {
        grant: (release) => {
          leave();
          resolve(release);
        },
        fail: (error) => {
          leave();
          reject(error);
        },
      };
      const onAbort = () => waiter.fail(signal!.reason);
      const timer = setTimeout(
        () => waiter.fail(new ExportBusyError("Timed out waiting for an export slot")),
        this.options.queueWaitMs,
      );
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting[0];
      if (next) {
        // The slot moves to the oldest waiter; `active` is unchanged.
        next.grant(this.releaser());
      } else {
        this.active -= 1;
      }
    };
  }
}

/** Only `[a-zA-Z0-9._-]` survive in the Content-Disposition filename (legacy rule). */
export function safeDownloadFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Nest-facing export runner (one per app, provided by CoreModule).
 */
@Injectable()
export class ExportDownloads {
  readonly limiter: ExportLimiter;
  private readonly shutdownDrainMs: number;

  constructor(
    @Inject(CONFIG) config: Config,
    private readonly shutdown: ShutdownCoordinator,
  ) {
    this.limiter = new ExportLimiter({
      maxConcurrent: config.exports.maxConcurrency,
      maxQueued: config.exports.maxQueued,
      queueWaitMs: EXPORT_QUEUE_WAIT_MS,
    });
    // A download still running at shutdown gets until 1 s before the
    // coordinator force-closes sockets, then is aborted.
    this.shutdownDrainMs = Math.max(
      0,
      config.lifecycle.shutdownGraceMs - SHUTDOWN_FORCE_CLOSE_LEAD_MS - 1_000,
    );
  }

  /**
   * Runs one export into `reply`:
   * 1. while draining, 503 SRV_5003 (+ Retry-After);
   * 2. waits for an export slot, or 503 EXPORT_BUSY + Retry-After;
   * 3. `prepare()` does the fallible lookups (404 etc. still answer as JSON);
   * 4. sends the headers and streams `write()` into the response. A client
   *    that disconnects aborts the generator; a failure after the headers
   *    destroys the response, so the client sees a broken download rather
   *    than a truncated file.
   * The slot is held until the response has finished or closed.
   */
  async stream(reply: FastifyReply, prepare: () => Promise<ExportDownload>): Promise<void> {
    this.shutdown.assertAcceptingStreams(reply);

    const controller = new AbortController();
    const res = reply.raw;
    const onClose = () => {
      if (!res.writableFinished) controller.abort(new ExportAbortedError("client-closed"));
    };
    res.on("close", onClose);

    let release: (() => void) | undefined;
    try {
      release = await this.limiter.acquire(controller.signal);
    } catch (err) {
      res.off("close", onClose);
      // The client left while queued: nobody is waiting for an answer.
      if (controller.signal.aborted) return;
      if (err instanceof ExportBusyError) {
        void reply.header("Retry-After", String(EXPORT_BUSY_RETRY_AFTER_SECONDS));
        throw new AppException(
          ErrorCodes.EXPORT_BUSY,
          "Too many exports are running; retry shortly",
          503,
        );
      }
      throw err;
    }

    let untrack: () => void = () => undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    try {
      const download = await prepare();
      // The client left while the export was being prepared.
      if (controller.signal.aborted) return;

      untrack = this.shutdown.trackStream(() => {
        drainTimer = setTimeout(
          () => controller.abort(new ExportAbortedError("shutdown")),
          this.shutdownDrainMs,
        );
        drainTimer.unref?.();
      });

      const out = new PassThrough({ highWaterMark: EXPORT_STREAM_HIGH_WATER_MARK });
      const responseDone = finished(res).catch(() => undefined);
      void reply
        .header("Content-Type", download.contentType)
        .header(
          "Content-Disposition",
          `attachment; filename="${safeDownloadFilename(download.filename)}"`,
        )
        .send(out);

      try {
        await Promise.race([
          download.write(out, controller.signal),
          abortPromise(controller.signal),
        ]);
      } catch (err) {
        const reason = controller.signal.aborted ? controller.signal.reason : err;
        if (reason instanceof ExportAbortedError) {
          logger.info({ filename: download.filename, reason: reason.reason }, "Export aborted");
        } else {
          logger.error({ err, filename: download.filename }, "Export failed after the response started");
        }
        controller.abort(reason);
        if (!out.destroyed) out.destroy(reason instanceof Error ? reason : new Error(String(reason)));
      }
      // Hold the slot until the bytes are out (or the connection is gone).
      await responseDone;
    } finally {
      clearTimeout(drainTimer);
      untrack();
      res.off("close", onClose);
      release();
    }
  }
}
