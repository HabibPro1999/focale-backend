import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";

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

describe("outbox service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.outboxEvent.create.mockResolvedValue({ id: "outbox-1" } as never);
    prismaMock.$executeRaw.mockResolvedValue(0);
  });

  it("enqueues outbox events with serialized payloads", async () => {
    await enqueueOutboxEvent(prismaMock as never, {
      type: "realtime.emit",
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
        type: "realtime.emit",
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

  it("claims and marks processed, skipped, and failed rows", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      { id: "processed" },
      { id: "skipped" },
      { id: "failed" },
    ]);
    prismaMock.outboxEvent.findMany.mockResolvedValue([
      {
        id: "processed",
        type: "realtime.emit",
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

    expect(result).toEqual({ processed: 1, skipped: 1, failed: 1 });
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
});
