import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { Prisma } from "@/generated/prisma/client.js";
import { REALTIME_EMIT_TYPE } from "./types.js";

const mocks = vi.hoisted(() => ({
  handleOutboxEvent: vi.fn(),
}));

vi.mock("./handlers.js", () => ({
  handleOutboxEvent: mocks.handleOutboxEvent,
}));

vi.mock("@shared/utils/logger.js", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { enqueueOutboxEvent, processOutboxEvents } from "./outbox.service.js";

function prismaUniqueError(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "7.2.0",
    meta,
  });
}

describe("outbox service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.outboxEvent.create.mockResolvedValue({ id: "outbox-1" } as never);
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it("enqueues outbox events with serialized payloads", async () => {
    await enqueueOutboxEvent(prismaMock as never, {
      type: REALTIME_EMIT_TYPE,
      aggregateType: "Registration",
      aggregateId: "registration-1",
      clientId: "client-1",
      eventId: "event-1",
      dedupeKey: "dedupe-1",
      payload: {
        type: "registration.created",
        clientId: "client-1",
        eventId: "event-1",
        payload: { id: "registration-1" },
        ts: 123,
      },
    });

    expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: REALTIME_EMIT_TYPE,
        aggregateType: "Registration",
        aggregateId: "registration-1",
        clientId: "client-1",
        eventId: "event-1",
        dedupeKey: "dedupe-1",
        payload: expect.objectContaining({
          type: "registration.created",
          payload: { id: "registration-1" },
        }),
      }),
    });
  });

  it("treats adapter P2002 without metadata as an outbox dedupe hit", async () => {
    prismaMock.outboxEvent.create.mockRejectedValueOnce(
      prismaUniqueError({}) as never,
    );

    await expect(
      enqueueOutboxEvent(prismaMock as never, {
        type: "email.abstract",
        aggregateType: "Abstract",
        aggregateId: "abstract-1",
        dedupeKey: "email:abstract:ABSTRACT_ACCEPTED:abstract-1",
        payload: {
          trigger: "ABSTRACT_ACCEPTED",
          abstractId: "abstract-1",
        },
      }),
    ).resolves.toBe(false);
  });

  it("treats plain adapter P2002 objects as outbox dedupe hits", async () => {
    prismaMock.outboxEvent.create.mockRejectedValueOnce({
      code: "P2002",
      meta: {},
    } as never);

    await expect(
      enqueueOutboxEvent(prismaMock as never, {
        type: "email.abstract",
        aggregateType: "Abstract",
        aggregateId: "abstract-1",
        dedupeKey: "email:abstract:ABSTRACT_ACCEPTED:abstract-1",
        payload: {
          trigger: "ABSTRACT_ACCEPTED",
          abstractId: "abstract-1",
        },
      }),
    ).resolves.toBe(false);
  });

  it("claims and marks processed, skipped, and failed rows", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      { id: "processed" },
      { id: "skipped" },
      { id: "failed" },
    ]);
    prismaMock.outboxEvent.findMany.mockResolvedValue([
      {
        id: "processed",
        type: REALTIME_EMIT_TYPE,
        payload: {},
        attemptCount: 1,
        maxAttempts: 5,
      },
      {
        id: "skipped",
        type: "email.triggered",
        payload: {},
        attemptCount: 1,
        maxAttempts: 5,
      },
      {
        id: "failed",
        type: "email.abstract",
        payload: {},
        attemptCount: 1,
        maxAttempts: 5,
      },
    ] as never);
    mocks.handleOutboxEvent
      .mockResolvedValueOnce("processed")
      .mockResolvedValueOnce("skipped")
      .mockRejectedValueOnce(new Error("boom"));

    const result = await processOutboxEvents(3, { workerId: "worker-1" });

    expect(result).toEqual({
      processed: 1,
      skipped: 1,
      failed: 1,
      leaseLost: 0,
    });
    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "processed" }),
        data: expect.objectContaining({ status: "PROCESSED" }),
      }),
    );
    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "skipped" }),
        data: expect.objectContaining({ status: "SKIPPED" }),
      }),
    );
    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "failed" }),
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  it("claims only realtime rows for realtime scope", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);

    await processOutboxEvents(3, {
      workerId: "worker-1",
      scope: "realtime",
    });

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(`AND "type" = '${REALTIME_EMIT_TYPE}'`),
      expect.any(Date),
      expect.any(Date),
      "worker-1",
      3,
    );
  });

  it("excludes realtime rows for background scope", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);

    await processOutboxEvents(3, {
      workerId: "worker-1",
      scope: "background",
    });

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(`AND "type" <> '${REALTIME_EMIT_TYPE}'`),
      expect.any(Date),
      expect.any(Date),
      "worker-1",
      3,
    );
  });

  it("reports lease-lost rows when status marking affects no rows", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: "processed" }]);
    prismaMock.outboxEvent.findMany.mockResolvedValue([
      {
        id: "processed",
        type: REALTIME_EMIT_TYPE,
        payload: {},
        attemptCount: 1,
        maxAttempts: 5,
      },
    ] as never);
    mocks.handleOutboxEvent.mockResolvedValueOnce("processed");
    prismaMock.outboxEvent.updateMany.mockResolvedValueOnce({
      count: 0,
    } as never);

    const result = await processOutboxEvents(1, { workerId: "worker-1" });

    expect(result).toEqual({
      processed: 0,
      skipped: 0,
      failed: 0,
      leaseLost: 1,
    });
  });

  it("renews the lease while a handler is in flight", async () => {
    vi.useFakeTimers();
    try {
      prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: "slow" }]);
      prismaMock.outboxEvent.findMany.mockResolvedValue([
        {
          id: "slow",
          type: REALTIME_EMIT_TYPE,
          payload: {},
          attemptCount: 1,
          maxAttempts: 5,
        },
      ] as never);

      let resolveHandler!: (value: "processed") => void;
      const handlerPromise = new Promise<"processed">((resolve) => {
        resolveHandler = resolve;
      });
      mocks.handleOutboxEvent.mockReturnValueOnce(handlerPromise);

      const processing = processOutboxEvents(1, {
        workerId: "worker-1",
        leaseMs: 2_000,
      });

      await vi.waitFor(() => {
        expect(mocks.handleOutboxEvent).toHaveBeenCalled();
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "slow",
            status: "PROCESSING",
            lockedBy: "worker-1",
          }),
          data: expect.objectContaining({
            lockedUntil: expect.any(Date),
          }),
        }),
      );

      resolveHandler("processed");
      await processing;
    } finally {
      vi.useRealTimers();
    }
  });
});
