import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { ExportBusyError, ExportLimiter, safeDownloadFilename } from "./stream-download";
import { ExportAbortedError, whenWritable, writeChunk } from "./stream-io";

const limiter = (maxConcurrent = 2, maxQueued = 4, queueWaitMs = 30_000) =>
  new ExportLimiter({ maxConcurrent, maxQueued, queueWaitMs });

/** Settles pending microtasks so granted waiters resolve. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("ExportLimiter (3.7)", () => {
  it("runs 2 at once, queues 4, refuses the 7th", async () => {
    const l = limiter();
    const releases = await Promise.all([l.acquire(), l.acquire()]);
    const queued = Array.from({ length: 4 }, () => l.acquire());

    expect(l).toMatchObject({ running: 2, queued: 4 });
    await expect(l.acquire()).rejects.toBeInstanceOf(ExportBusyError);
    expect(l).toMatchObject({ running: 2, queued: 4 });

    releases.forEach((release) => release());
    await flush();
    expect(l).toMatchObject({ running: 2, queued: 2 });
    (await Promise.all(queued.slice(0, 2))).forEach((release) => release());
    await flush();
    expect(l).toMatchObject({ running: 2, queued: 0 });
    (await Promise.all(queued.slice(2))).forEach((release) => release());
    expect(l).toMatchObject({ running: 0, queued: 0 });
  });

  it("hands a freed slot to the oldest waiter", async () => {
    const l = limiter(1, 4);
    const first = await l.acquire();
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      l.acquire().then((release) => {
        order.push(n);
        return release;
      }),
    );

    first();
    (await waiters[0]!)();
    (await waiters[1]!)();
    (await waiters[2]!)();

    expect(order).toEqual([1, 2, 3]);
    expect(l.running).toBe(0);
  });

  it("releases each slot once, however often release is called", async () => {
    const l = limiter(2, 0);
    const release = await l.acquire();
    await l.acquire();
    release();
    release();
    expect(l.running).toBe(1);
  });

  it("with no queue, refuses as soon as every slot is taken", async () => {
    const l = limiter(1, 0);
    await l.acquire();
    await expect(l.acquire()).rejects.toBeInstanceOf(ExportBusyError);
  });

  it("drops a waiter whose client left, with the abort reason", async () => {
    const l = limiter(1, 4);
    const running = await l.acquire();
    const controller = new AbortController();
    const waiting = l.acquire(controller.signal);
    const behind = l.acquire();
    expect(l.queued).toBe(2);

    controller.abort(new ExportAbortedError("client-closed"));
    await expect(waiting).rejects.toMatchObject({ reason: "client-closed" });
    expect(l.queued).toBe(1);

    running();
    const release = await behind;
    expect(l).toMatchObject({ running: 1, queued: 0 });
    release();
  });

  it("refuses an already-aborted request without queueing it", async () => {
    const l = limiter(1, 4);
    await l.acquire();
    const controller = new AbortController();
    controller.abort(new ExportAbortedError("client-closed"));
    await expect(l.acquire(controller.signal)).rejects.toMatchObject({ reason: "client-closed" });
    expect(l.queued).toBe(0);
  });

  it("gives up with ExportBusyError after the queue wait", async () => {
    vi.useFakeTimers();
    const l = limiter(1, 4, 30_000);
    await l.acquire();
    const waiting = l.acquire();
    const assertion = expect(waiting).rejects.toBeInstanceOf(ExportBusyError);

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(l).toMatchObject({ running: 1, queued: 0 });
  });
});

describe("export stream helpers (3.7)", () => {
  it("keeps only [a-zA-Z0-9._-] in the download filename", () => {
    expect(safeDownloadFilename('congrès "2026"/résumé.xlsx')).toBe("congr_s__2026__r_sum_.xlsx");
  });

  it("whenWritable resolves at once with room, waits for drain when full", async () => {
    const signal = new AbortController().signal;
    const out = new PassThrough({ highWaterMark: 4 });
    await whenWritable(out, signal);

    expect(out.write("12345")).toBe(false);
    let drained = false;
    const waiting = whenWritable(out, signal).then(() => (drained = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    out.read();
    await waiting;
    expect(drained).toBe(true);
  });

  it("whenWritable rejects with the abort reason, or when the stream closes", async () => {
    const controller = new AbortController();
    const full = new PassThrough({ highWaterMark: 1 });
    full.write("xx");
    const waiting = whenWritable(full, controller.signal);
    controller.abort(new ExportAbortedError("shutdown"));
    await expect(waiting).rejects.toMatchObject({ reason: "shutdown" });
    expect(full.listenerCount("drain")).toBe(0);

    const closing = new PassThrough({ highWaterMark: 1 });
    closing.write("xx");
    const closed = whenWritable(closing, new AbortController().signal);
    closing.destroy();
    await expect(closed).rejects.toMatchObject({ reason: "client-closed" });
  });

  it("writeChunk waits for the consumer (backpressure)", async () => {
    const received: string[] = [];
    let release!: () => void;
    const slow = new Writable({
      highWaterMark: 4,
      write(chunk: Buffer, _encoding, callback) {
        received.push(chunk.toString());
        release = callback;
      },
    });
    const signal = new AbortController().signal;

    const first = writeChunk(slow, "12345", signal);
    let done = false;
    void first.then(() => (done = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    release();
    await first;
    expect(received).toEqual(["12345"]);
  });
});
