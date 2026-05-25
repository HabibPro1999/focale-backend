import { describe, it, expect, beforeEach, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import type { RegistrationPostCommitEvent } from "./registration-side-effects.js";
import {
  emitRegistrationPostCommitEvents,
  queueRegistrationCreatedEmail,
} from "./registration-side-effects.js";

describe("registration side effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.outboxEvent.create.mockResolvedValue({ id: "outbox-1" } as never);
  });

  it("enqueues post-commit events in order", async () => {
    const events: RegistrationPostCommitEvent[] = [
      {
        type: "registration.created",
        clientId: "client-1",
        eventId: "event-1",
        payload: { id: "registration-1", email: "test@example.com" },
        ts: 100,
      },
      {
        type: "eventAccess.countsChanged",
        clientId: "client-1",
        eventId: "event-1",
        payload: { id: "event-1", accessIds: ["access-1"] },
        ts: 101,
      },
    ];

    await emitRegistrationPostCommitEvents(prismaMock as never, events);

    expect(prismaMock.outboxEvent.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.outboxEvent.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          type: "realtime.emit",
          payload: events[0],
        }),
      }),
    );
    expect(prismaMock.outboxEvent.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          type: "realtime.emit",
          payload: events[1],
        }),
      }),
    );
  });

  it("enqueues the registration-created email", async () => {
    await queueRegistrationCreatedEmail(prismaMock as never, {
      eventId: "event-1",
      registration: {
        id: "registration-1",
        email: "test@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      },
      failureMessage: "Failed to queue confirmation email",
    });
    expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "email.triggered",
          dedupeKey: "email:triggered:REGISTRATION_CREATED:registration-1",
          payload: {
            trigger: "REGISTRATION_CREATED",
            eventId: "event-1",
            registration: {
              id: "registration-1",
              email: "test@example.com",
              firstName: "Ada",
              lastName: "Lovelace",
            },
          },
        }),
      }),
    );
  });

  it("surfaces enqueue failures to the caller", async () => {
    const err = new Error("enqueue failed");
    prismaMock.outboxEvent.create.mockRejectedValue(err);

    await expect(
      queueRegistrationCreatedEmail(prismaMock as never, {
        eventId: "event-1",
        registration: {
          id: "registration-1",
          email: "test@example.com",
        },
        failureMessage: "Failed to queue confirmation email",
      }),
    ).rejects.toThrow(err);
  });
});
