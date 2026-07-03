import { describe, it, expect, beforeEach, vi } from "vitest";

const getSignedUrl = vi.fn();

vi.mock("@app/db", () => ({
  enqueueAbstractBookJob: vi.fn(),
  listAbstractBookJobs: vi.fn(),
  getAbstractBookJob: vi.fn(),
}));
vi.mock("@app/integrations", () => ({
  getStorageProvider: () => ({ getSignedUrl }),
}));

import {
  enqueueAbstractBookJob,
  listAbstractBookJobs,
  getAbstractBookJob,
} from "@app/db";
import { AbstractsBookService } from "./abstracts.book.service";
import { AppException } from "./app-exception";

const mock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const eventId = "event-1";
const jobId = "job-1";
const service = new AbstractsBookService();

async function expectStatus(p: Promise<unknown>, status: number): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).getStatus()).toBe(status);
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    eventId,
    requestedBy: "admin-1",
    status: "PENDING",
    storageKey: null,
    errorMessage: null,
    includedCount: 0,
    attemptCount: 0,
    maxAttempts: 3,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lockedAt: null,
    lockedUntil: null,
    lockedBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  getSignedUrl.mockReset();
});

describe("AbstractsBookService.enqueue", () => {
  it("blocks (409) with unfinishedCount while abstracts remain unfinalized", async () => {
    mock(enqueueAbstractBookJob).mockResolvedValue({
      ok: false,
      reason: "unfinished",
      unfinishedCount: 3,
    });

    const err = await service.enqueue(eventId, "admin-1").then(
      () => {
        throw new Error("expected reject");
      },
      (e: unknown) => e as AppException,
    );
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: "STT_12001",
      details: { unfinishedCount: 3 },
    });
  });

  it("404s when no abstract config exists", async () => {
    mock(enqueueAbstractBookJob).mockResolvedValue({
      ok: false,
      reason: "no_config",
    });
    await expectStatus(service.enqueue(eventId, "admin-1"), 404);
  });

  it("returns the formatted job (no download URL) on success", async () => {
    mock(enqueueAbstractBookJob).mockResolvedValue({
      ok: true,
      job: makeJob(),
    });

    const result = await service.enqueue(eventId, "admin-1");

    expect(enqueueAbstractBookJob).toHaveBeenCalledWith({
      eventId,
      requestedBy: "admin-1",
    });
    expect(result).toMatchObject({
      id: jobId,
      status: "PENDING",
      downloadUrl: null,
    });
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});

describe("AbstractsBookService.list", () => {
  it("returns the last jobs with fresh signed URLs for completed ones only", async () => {
    mock(listAbstractBookJobs).mockResolvedValue([
      makeJob({
        id: "completed",
        status: "COMPLETED",
        storageKey: `${eventId}/abstracts/book/completed.pdf`,
      }),
      makeJob({ id: "pending", status: "PENDING" }),
    ]);
    getSignedUrl.mockResolvedValue("https://signed.example.com/book.pdf");

    const result = await service.list(eventId);

    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    expect(getSignedUrl).toHaveBeenCalledWith(
      `${eventId}/abstracts/book/completed.pdf`,
      3600,
    );
    expect(result[0]).toMatchObject({
      id: "completed",
      downloadUrl: "https://signed.example.com/book.pdf",
    });
    expect(result[1]).toMatchObject({ id: "pending", downloadUrl: null });
  });
});

describe("AbstractsBookService.get", () => {
  it("404s when the job is missing / event mismatched", async () => {
    mock(getAbstractBookJob).mockResolvedValue(null);
    await expectStatus(service.get(eventId, jobId), 404);
  });

  it("returns a signed URL + retry metadata for a completed job", async () => {
    mock(getAbstractBookJob).mockResolvedValue(
      makeJob({
        status: "COMPLETED",
        storageKey: `${eventId}/abstracts/book/${jobId}.pdf`,
        includedCount: 1,
        attemptCount: 2,
        maxAttempts: 3,
        lastAttemptAt: new Date("2026-01-01T00:00:30.000Z"),
        completedAt: new Date("2026-01-01T00:01:00.000Z"),
      }),
    );
    getSignedUrl.mockResolvedValue("https://signed.example.com/book.pdf");

    const result = await service.get(eventId, jobId);

    expect(getAbstractBookJob).toHaveBeenCalledWith(eventId, jobId);
    expect(getSignedUrl).toHaveBeenCalledWith(
      `${eventId}/abstracts/book/${jobId}.pdf`,
      3600,
    );
    expect(result).toMatchObject({
      downloadUrl: "https://signed.example.com/book.pdf",
      attemptCount: 2,
      maxAttempts: 3,
      lastAttemptAt: "2026-01-01T00:00:30.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
    });
  });
});
