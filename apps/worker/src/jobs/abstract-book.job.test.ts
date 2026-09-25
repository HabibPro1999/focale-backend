import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  ABSTRACT_BOOK_LEASE_MS: 3_600_000,
  recoverStaleAbstractBookJobs: vi.fn(),
  claimAbstractBookJobs: vi.fn(),
  getAbstractBookData: vi.fn(),
  completeAbstractBookJob: vi.fn(),
  failAbstractBookJob: vi.fn(),
  stampAbstractBookJobLease: vi.fn(),
}));
vi.mock("@app/db", () => db);
const storage = vi.hoisted(() => ({ uploadPrivate: vi.fn() }));
vi.mock("@app/integrations", () => ({ getStorageProvider: () => storage }));
const pdf = vi.hoisted(() => ({ generateAbstractBookPdf: vi.fn() }));
vi.mock("./book/pdf", () => pdf);
vi.mock("@app/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/shared")>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
}));

import { AbstractBookJob } from "./abstract-book.job";
import { JobTimeoutError, WorkerShutdownError, type JobContext } from "../job";

const row = { id: "job-1", eventId: "event-1", attemptCount: 1, maxAttempts: 3 };

function ctx(signal: AbortSignal): JobContext {
  return { signal, deadline: Date.now() + 60_000, log: {} as JobContext["log"] };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.recoverStaleAbstractBookJobs.mockResolvedValue(undefined);
  db.claimAbstractBookJobs.mockResolvedValue([row]);
  db.getAbstractBookData.mockResolvedValue({ abstracts: [] });
  db.completeAbstractBookJob.mockResolvedValue(1);
  db.failAbstractBookJob.mockResolvedValue(1);
  storage.uploadPrivate.mockResolvedValue("stored-key");
});

describe("AbstractBookJob and its abort signal", () => {
  it("has the plan's 30 min budget and completes a normal render", async () => {
    const job = new AbstractBookJob();
    expect(job.timeoutMs).toBe(30 * 60_000);
    pdf.generateAbstractBookPdf.mockResolvedValue({ buffer: Buffer.from("pdf"), includedCount: 2 });
    await job.run(ctx(new AbortController().signal));
    expect(db.completeAbstractBookJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", includedCount: 2 }));
  });

  it("does not claim a job once the signal has aborted", async () => {
    await new AbstractBookJob().run(ctx(AbortSignal.abort(new WorkerShutdownError())));
    expect(db.claimAbstractBookJobs).not.toHaveBeenCalled();
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
      expect.objectContaining({ jobId: "job-1", message: "Job abstract-book exceeded its 1800000 ms timeout" }),
    );
  });

  it("on a shutdown abort, stops before uploading and leaves the job for lease recovery (no attempt charged)", async () => {
    const controller = new AbortController();
    pdf.generateAbstractBookPdf.mockImplementation(async () => {
      controller.abort(new WorkerShutdownError());
      return { buffer: Buffer.from("pdf"), includedCount: 2 };
    });
    await new AbstractBookJob().run(ctx(controller.signal));
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
    expect(db.failAbstractBookJob).not.toHaveBeenCalled();
    expect(db.completeAbstractBookJob).not.toHaveBeenCalled();
  });
});
