/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { AbstractBookJobStatus, AbstractStatus } from "@/generated/prisma/client.js";

const uploadPrivate = vi.fn();
const getSignedUrl = vi.fn();

vi.mock("@shared/services/storage/index.js", () => ({
  getStorageProvider: () => ({ uploadPrivate, getSignedUrl }),
}));
vi.mock("@shared/utils/audit.js", () => ({ auditLog: vi.fn() }));

import {
  enqueueAbstractBookJob,
  generateAbstractBookPdf,
  getAbstractBookJob,
  getAbstractBookQueueHealth,
  processAbstractBookJobs,
  recoverStaleAbstractBookJobs,
} from "./abstracts.book.service.js";

const eventId = "event-1";
const jobId = "job-1";

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    eventId,
    requestedBy: "admin-1",
    status: AbstractBookJobStatus.PENDING,
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

function makeEvent() {
  return {
    id: eventId,
    name: "Congress 2026",
    abstractConfig: {
      bookFontFamily: "Arial",
      bookFontSize: 11,
      bookLineSpacing: 1.5,
      bookOrder: "BY_CODE",
      bookIncludeAuthorNames: true,
    },
  };
}

function makeAcceptedAbstract(overrides: Record<string, unknown> = {}) {
  return {
    id: "abstract-1",
    eventId,
    authorFirstName: "Ada",
    authorLastName: "Lovelace",
    authorAffiliation: "Analytical Institute",
    authorEmail: "ada@example.com",
    authorPhone: "+21612345678",
    requestedType: "ORAL_COMMUNICATION",
    finalType: "ORAL_COMMUNICATION",
    content: { mode: "FREE_TEXT", title: "Analytical Engine", body: "A concise abstract body." },
    coAuthors: [{ firstName: "Grace", lastName: "Hopper" }],
    additionalFieldsData: {},
    code: "001-OC",
    codeNumber: 1,
    status: AbstractStatus.ACCEPTED,
    contentVersion: 1,
    averageScore: 18,
    reviewCount: 2,
    finalFileKey: null,
    finalFileKind: null,
    finalFileSize: null,
    finalFileUploadedAt: null,
    editToken: "token",
    lastEditedAt: null,
    linkBaseUrl: "https://events.example.com",
    registrationId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    themes: [{ theme: { label: "Cardiology", sortOrder: 0 } }],
    ...overrides,
  };
}

beforeEach(() => {
  uploadPrivate.mockReset();
  getSignedUrl.mockReset();
  prismaMock.$executeRawUnsafe.mockResolvedValue(0 as any);
});

describe("abstracts book service", () => {
  it("blocks enqueue while abstracts remain unfinalized", async () => {
    prismaMock.abstractConfig.findUnique.mockResolvedValue({ id: "config-1" } as any);
    prismaMock.abstract.count.mockResolvedValue(1);

    await expect(enqueueAbstractBookJob(eventId, "admin-1")).rejects.toMatchObject({
      statusCode: 409,
    });

    expect(prismaMock.abstractBookJob.create).not.toHaveBeenCalled();
  });

  it("enqueues a book job when all abstracts are finalized", async () => {
    prismaMock.abstractConfig.findUnique.mockResolvedValue({ id: "config-1" } as any);
    prismaMock.abstract.count.mockResolvedValue(0);
    prismaMock.abstractBookJob.create.mockResolvedValue(makeJob() as any);

    const result = await enqueueAbstractBookJob(eventId, "admin-1");

    expect(prismaMock.abstractBookJob.create).toHaveBeenCalledWith({
      data: { eventId, requestedBy: "admin-1", status: "PENDING" },
    });
    expect(result).toMatchObject({ id: jobId, status: "PENDING" });
  });

  it("generates a PDF buffer from accepted abstracts", async () => {
    prismaMock.event.findUnique.mockResolvedValue(makeEvent() as any);
    prismaMock.abstract.findMany.mockResolvedValue([makeAcceptedAbstract()] as any);

    const result = await generateAbstractBookPdf(eventId);

    expect(result.includedCount).toBe(1);
    expect(result.buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("processes pending jobs and stores generated PDFs privately", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      makeJob({
        status: AbstractBookJobStatus.RUNNING,
        attemptCount: 1,
        lockedBy: "worker-a",
      }),
    ] as any);
    prismaMock.abstractBookJob.updateMany.mockResolvedValue({ count: 1 } as any);
    prismaMock.event.findUnique.mockResolvedValue(makeEvent() as any);
    prismaMock.abstract.findMany.mockResolvedValue([makeAcceptedAbstract()] as any);
    uploadPrivate.mockResolvedValue(`${eventId}/abstracts/book/${jobId}.pdf`);

    const result = await processAbstractBookJobs(1, { workerId: "worker-a", heartbeatMs: 60_000 });

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE SKIP LOCKED"),
      expect.any(Date),
      expect.any(Date),
      "worker-a",
      1,
    );
    expect(uploadPrivate).toHaveBeenCalledWith(
      expect.any(Buffer),
      `${eventId}/abstracts/book/${jobId}.pdf`,
      "application/pdf",
      { contentDisposition: `attachment; filename="abstract-book-${eventId}.pdf"` },
    );
    expect(prismaMock.abstractBookJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: jobId, status: AbstractBookJobStatus.RUNNING, lockedBy: "worker-a" },
      data: expect.objectContaining({
        status: "COMPLETED",
        storageKey: `${eventId}/abstracts/book/${jobId}.pdf`,
        includedCount: 1,
        completedAt: expect.any(Date),
        lockedAt: null,
        lockedUntil: null,
        lockedBy: null,
      }),
    }));
    expect(result.processed).toBe(1);
  });

  it("requeues failed jobs when attempts remain", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      makeJob({ status: AbstractBookJobStatus.RUNNING, attemptCount: 1, maxAttempts: 3, lockedBy: "worker-a" }),
    ] as any);
    prismaMock.event.findUnique.mockRejectedValue(new Error("PDF failed"));
    prismaMock.abstractBookJob.updateMany.mockResolvedValue({ count: 1 } as any);

    const result = await processAbstractBookJobs(1, { workerId: "worker-a" });

    expect(result.processed).toBe(1);
    expect(prismaMock.abstractBookJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: jobId, status: AbstractBookJobStatus.RUNNING, lockedBy: "worker-a" },
      data: expect.objectContaining({
        status: AbstractBookJobStatus.PENDING,
        errorMessage: "PDF failed",
        completedAt: null,
        nextAttemptAt: expect.any(Date),
      }),
    }));
  });

  it("dead-letters failed jobs when max attempts are exhausted", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      makeJob({ status: AbstractBookJobStatus.RUNNING, attemptCount: 3, maxAttempts: 3, lockedBy: "worker-a" }),
    ] as any);
    prismaMock.event.findUnique.mockRejectedValue(new Error("PDF failed"));
    prismaMock.abstractBookJob.updateMany.mockResolvedValue({ count: 1 } as any);

    await processAbstractBookJobs(1, { workerId: "worker-a" });

    expect(prismaMock.abstractBookJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: AbstractBookJobStatus.FAILED,
        completedAt: expect.any(Date),
        nextAttemptAt: null,
      }),
    }));
  });

  it("recovers stale running jobs", async () => {
    prismaMock.$executeRawUnsafe
      .mockResolvedValueOnce(1 as any)
      .mockResolvedValueOnce(2 as any);

    const result = await recoverStaleAbstractBookJobs(new Date("2026-01-01T00:00:00.000Z"));

    expect(result).toEqual({ requeued: 1, deadLettered: 2 });
    expect(prismaMock.$executeRawUnsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('"status" = \'PENDING\''),
      expect.any(Date),
      expect.any(Date),
      expect.any(Date),
      expect.any(Date),
    );
    expect(prismaMock.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('"status" = \'FAILED\''),
      expect.any(Date),
    );
  });

  it("reports abstract book queue health", async () => {
    prismaMock.abstractBookJob.count
      .mockResolvedValueOnce(2 as any)
      .mockResolvedValueOnce(1 as any)
      .mockResolvedValueOnce(1 as any)
      .mockResolvedValueOnce(0 as any)
      .mockResolvedValueOnce(3 as any);
    prismaMock.abstractBookJob.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 1000) } as any);

    const health = await getAbstractBookQueueHealth();

    expect(health).toMatchObject({
      pendingCount: 2,
      duePendingCount: 1,
      runningCount: 1,
      staleRunningCount: 0,
      failedCount: 3,
      isHealthy: true,
    });
  });

  it("returns a signed URL and retry metadata for completed jobs", async () => {
    prismaMock.abstractBookJob.findUnique.mockResolvedValue(makeJob({
      status: AbstractBookJobStatus.COMPLETED,
      storageKey: `${eventId}/abstracts/book/${jobId}.pdf`,
      includedCount: 1,
      attemptCount: 2,
      maxAttempts: 3,
      lastAttemptAt: new Date("2026-01-01T00:00:30.000Z"),
      completedAt: new Date("2026-01-01T00:01:00.000Z"),
    }) as any);
    getSignedUrl.mockResolvedValue("https://signed.example.com/book.pdf");

    const result = await getAbstractBookJob(eventId, jobId);

    expect(getSignedUrl).toHaveBeenCalledWith(`${eventId}/abstracts/book/${jobId}.pdf`, 3600);
    expect(result).toMatchObject({
      downloadUrl: "https://signed.example.com/book.pdf",
      attemptCount: 2,
      maxAttempts: 3,
      lastAttemptAt: "2026-01-01T00:00:30.000Z",
    });
  });
});
