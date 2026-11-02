import { PassThrough, type Readable, type Writable } from "node:stream";

// =============================================================================
// EXPORT STREAM I/O
// What a file generator needs to write into a download: the prepared-download
// shape, the abort reason, and backpressure-aware writes. No Nest here, so
// builders and load runs import it without the app.
// =============================================================================

/** Why an export stopped early: the client left, or the process is shutting down. */
export class ExportAbortedError extends Error {
  constructor(readonly reason: "client-closed" | "shutdown") {
    super(reason === "shutdown" ? "Export aborted by shutdown" : "Client closed the export");
    this.name = "ExportAbortedError";
  }
}

/** A prepared file: everything that can fail with an HTTP error has run. */
export interface ExportDownload {
  filename: string;
  contentType: string;
  /**
   * Writes the file into `out` and ends it. Honors backpressure (see
   * writeChunk / whenWritable) and stops with the signal's reason once
   * `signal` aborts.
   */
  write(out: Writable, signal: AbortSignal): Promise<void>;
}

/**
 * Whether a write was refused and 'drain' is pending. Streams from the
 * `readable-stream` package (archiver's entry streams) predate
 * `writableNeedDrain`, so their internal state is read instead.
 */
function needsDrain(out: Writable): boolean {
  if (typeof out.writableNeedDrain === "boolean") return out.writableNeedDrain;
  return (out as { _writableState?: { needDrain?: boolean } })._writableState?.needDrain === true;
}

/**
 * Resolves once `out` can take more data; rejects if `signal` aborts or the
 * stream closes first. Generators call it between pages, so at most about one
 * page sits in memory beyond the stream's high-water mark.
 */
export function whenWritable(out: Writable, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (out.destroyed) return Promise.reject(new ExportAbortedError("client-closed"));
  if (!needsDrain(out)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      out.off("drain", onDrain);
      out.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ExportAbortedError("client-closed"));
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    out.on("drain", onDrain);
    out.on("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Writes one chunk and waits for room when the stream is full. */
export async function writeChunk(
  out: Writable,
  chunk: string | Buffer,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!out.write(chunk)) await whenWritable(out, signal);
}

/**
 * Settles like `work`, or rejects with the signal's reason as soon as
 * `signal` aborts (`work` is then left to settle on its own, its outcome
 * ignored). For steps that may never settle once aborted, such as a
 * workbook commit whose zip was abandoned.
 */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Bytes a download body buffers ahead of its reader (as in ExportDownloads). */
const DOWNLOAD_BODY_HIGH_WATER_MARK = 1024 * 1024;

/**
 * The file as a stream, for a route that sends the body itself
 * (`reply.send(body)`) instead of handing its reply to ExportDownloads. The
 * file is generated as the body is read; destroying the body (Fastify does
 * when the client goes away) aborts generation, and a generation failure
 * destroys the body, so the client sees a broken download. No admission
 * control and no shutdown tracking: prefer ExportDownloads.stream().
 */
export function downloadBody(download: ExportDownload): Readable {
  const body = new PassThrough({ highWaterMark: DOWNLOAD_BODY_HIGH_WATER_MARK });
  const controller = new AbortController();
  let settled = false;
  body.once("close", () => {
    if (!settled) controller.abort(new ExportAbortedError("client-closed"));
  });
  raceAbort(download.write(body, controller.signal), controller.signal).then(
    () => {
      settled = true;
    },
    (err: unknown) => {
      settled = true;
      if (!body.destroyed) body.destroy(err instanceof Error ? err : new Error(String(err)));
    },
  );
  return body;
}
