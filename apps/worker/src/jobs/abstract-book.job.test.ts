import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake lease queue driven by the real runLeased: the job's lease behaviour
// (heartbeat, lost lease, release on shutdown) is runLeased's, exercised here
// against the job's handlers. The SQL is covered by the DB contract suite.
const queue = vi.hoisted(() => ({
  spec: { name: "abstract-book", leaseMs: 300_000 },
  claim: vi.fn(),
  renew: vi.fn(),
  confirm: vi.fn(),
  release: vi.fn(),
}));
const db = vi.hoisted(() => ({
  loadClaimedAbstractBookJobs: vi.fn(),
  getAbstractBookData: vi.fn(),
  completeAbstractBookJob: vi.fn(),
  failAbstractBookJob: vi.fn(),
}));
vi.mock("@app/db", async () => {
  const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
  return {
    ...db,
    abstractBookQueue: queue,
    runLeased: actual.runLeased,
    LeaseLostError: actual.LeaseLostError,
    ABSTRACT_BOOK_LEASE_MS: actual.ABSTRACT_BOOK_LEASE_MS,
  };
});
const storage = vi.hoisted(() => ({ uploadPrivate: vi.fn() }));
vi.mock("@app/integrations", () => ({ getStorageProvider: () => storage }));
const pdf = vi.hoisted(() => ({ generateAbstractBookPdf: vi.fn() }));
vi.mock("./book/pdf", () => pdf);
vi.mock("@app/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/shared")>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
}));

import { ABSTRACT_BOOK_LEASE_MS, LeaseLostError } from "@app/db";
import { AbstractBookJob } from "./abstract-book.job";
import { JobTimeoutError, WorkerShutdownError, type JobContext } from "../job";

const row = { id: "job-1", eventId: "event-1", attemptCount: 1, maxAttempts: 3 };

function ctx(signal: AbortSignal): JobContext {
  return { signal, deadline: Date.now() + 60_000, log: {} as JobContext["log"] };
}

/** A render that runs until its signal aborts, then rejects with the reason. */
function renderUntilAborted() {
  pdf.generateAbstractBookPdf.mockImplementation(
    (_data: unknown, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  queue.claim.mockResolvedValue(["job-1"]);
  queue.renew.mockImplementation(async (_worker: string, ids: string[]) => ids);
  queue.confirm.mockResolvedValue(true);
  queue.release.mockImplementation(async (_worker: string, ids: string[]) => ids.length);
  db.loadClaimedAbstractBookJobs.mockResolvedValue([row]);
  db.getAbstractBookData.mockResolvedValue({ abstracts: [] });
  db.completeAbstractBookJob.mockResolvedValue(true);
  db.failAbstractBookJob.mockResolvedValue(true);
  storage.uploadPrivate.mockResolvedValue("stored-key");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AbstractBookJob on the lease queue", () => {
  it("has a 30 min budget and a 5 min lease, and completes a normal render as the lease owner", async () => {
    const job = new AbstractBookJob();
    expect(job.timeoutMs).toBe(30 * 60_000);
    expect(ABSTRACT_BOOK_LEASE_MS).toBe(5 * 60_000);
    pdf.generateAbstractBookPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), includedCount: 2 });

    await job.run(ctx(new AbortController().signal));

    expect(queue.claim).toHaveBeenCalledWith(expect.any(String), 1, 300_000);
    const workerId = queue.claim.mock.calls[0]![0] as string;
    expect(db.loadClaimedAbstractBookJobs).toHaveBeenCalledWith(["job-1"], workerId);
    expect(queue.confirm).toHaveBeenCalledWith(workerId, "job-1", 300_000);
    expect(pdf.generateAbstractBookPdf).toHaveBeenCalledWith({ abstracts: [] }, { signal: expect.any(AbortSignal) });
    expect(storage.uploadPrivate).toHaveBeenCalledWith(
      Buffer.from("pdf"),
      "event-1/abstracts/book/job-1.pdf",
      "application/pdf",
      expect.any(Object),
    );
    expect(db.completeAbstractBookJob).toHaveBeenCalledWith({
      jobId: "job-1",
      workerId,
      storageKey: "stored-key",
      includedCount: 2,
    });
    expect(queue.release).not.toHaveBeenCalled();
  });

  it("does not claim a job once the signal has aborted", async () => {
    await new AbstractBookJob().run(ctx(AbortSignal.abort(new WorkerShutdownError())));
    expect(queue.claim).not.toHaveBeenCalled();
  });

  it("does not render when the ownership confirm finds the job taken over", async () => {
    queue.confirm.mockResolvedValue(false);
    await new AbstractBookJob().run(ctx(new AbortController().signal));
    expect(pdf.generateAbstractBookPdf).not.toHaveBeenCalled();
    expect(db.failAbstractBookJob).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
  });

  it("aborts the render when a heartbeat finds the lease lost, and writes nothing", async () => {
    vi.useFakeTimers();
    renderUntilAborted();
    const run = new AbstractBookJob().run(ctx(new AbortController().signal));

    // First heartbeat (a third of the lease): still owned, the render goes on.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(queue.renew).toHaveBeenCalledTimes(1);
    // Second: the job was recovered and claimed elsewhere.
    queue.renew.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(100_000);
    await run;

    const signal = pdf.generateAbstractBookPdf.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.reason).toBeInstanceOf(LeaseLostError);
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
    expect(db.completeAbstractBookJob).not.toHaveBeenCalled();
    expect(db.failAbstractBookJob).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
  });

  it("a renewal error is not a lost lease: the render continues", async () => {
    vi.useFakeTimers();
    let finish: (value: unknown) => void = () => {};
    pdf.generateAbstractBookPdf.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    queue.renew.mockRejectedValueOnce(new Error("db blip"));
    const run = new AbstractBookJob().run(ctx(new AbortController().signal));

    await vi.advanceTimersByTimeAsync(100_000);
    finish({ buffer: Buffer.from("pdf"), includedCount: 1 });
    await run;

    expect(db.completeAbstractBookJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", includedCount: 1 }));
  });

  it("on a timeout abort, stops before uploading and fails the job (an attempt is charged)", async () => {
    const controller = new AbortController();
    pdf.generateAbstractBookPdf.mockImplementation(async () => {
      controller.abort(new JobTimeoutError("abstract-book", 1_800_000));
      return { buffer: Buffer.from("pdf"), includedCount: 2 };
    });
    await new AbstractBookJob().run(ctx(controller.signal));
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
    expect(db.failAbstractBookJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        attemptCount: 1,
        maxAttempts: 3,
        message: "Job abstract-book exceeded its 1800000 ms timeout",
      }),
    );
    expect(queue.release).not.toHaveBeenCalled();
  });

  it("on a shutdown abort, stops the render and releases the job without an attempt charged", async () => {
    const controller = new AbortController();
    renderUntilAborted();
    const run = new AbstractBookJob().run(ctx(controller.signal));
    await vi.waitFor(() => expect(pdf.generateAbstractBookPdf).toHaveBeenCalled());
    controller.abort(new WorkerShutdownError());
    await run;

    expect(storage.uploadPrivate).not.toHaveBeenCalled();
    expect(db.failAbstractBookJob).not.toHaveBeenCalled();
    expect(db.completeAbstractBookJob).not.toHaveBeenCalled();
    expect(queue.release).toHaveBeenCalledWith(expect.any(String), ["job-1"]);
  });

  it("a render error fails the job with its message", async () => {
    db.getAbstractBookData.mockResolvedValue(null);
    await new AbstractBookJob().run(ctx(new AbortController().signal));
    expect(db.failAbstractBookJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1", message: "Abstract configuration not found" }),
    );
  });
});
