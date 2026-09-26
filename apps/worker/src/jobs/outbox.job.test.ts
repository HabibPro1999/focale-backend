import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  queueTriggeredEmail: vi.fn(),
  queueSponsorshipEmail: vi.fn(),
  queueAbstractEmail: vi.fn(),
  handleStorageDeleteOutbox: vi.fn(),
  handleAccessCapacityReachedOutbox: vi.fn(),
}));

vi.mock("@app/shared", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@app/integrations", () => ({
  queueTriggeredEmail: mocks.queueTriggeredEmail,
  queueSponsorshipEmail: mocks.queueSponsorshipEmail,
  queueAbstractEmail: mocks.queueAbstractEmail,
  handleStorageDeleteOutbox: mocks.handleStorageDeleteOutbox,
}));

// @app/db only supplies types + processOutboxEvents (unused here); stub it so
// importing the job module never touches a real database client.
vi.mock("@app/db", () => ({
  processOutboxEvents: vi.fn(),
  ACCESS_CAPACITY_REACHED_OUTBOX_TYPE: "access.capacityReached",
  handleAccessCapacityReachedOutbox: mocks.handleAccessCapacityReachedOutbox,
}));

import { buildOutboxHandlers } from "./outbox.job";

describe("outbox handler registry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers exactly the background handlers: three email types, storage.delete and access.capacityReached (no realtime.emit)", () => {
    const handlers = buildOutboxHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "access.capacityReached",
      "email.abstract",
      "email.sponsorship",
      "email.triggered",
      "storage.delete",
    ]);
    expect(handlers["realtime.emit"]).toBeUndefined();
    expect(handlers["networking.notify"]).toBeUndefined();
  });

  it("storage.delete → handleStorageDeleteOutbox(payload), passing its verdict through", async () => {
    const handlers = buildOutboxHandlers();
    const payload = { url: "https://cdn.test/networking/e/profiles/p/a.webp", ownerPrefix: "networking/e/profiles/p", reason: "test" };
    mocks.handleStorageDeleteOutbox.mockResolvedValueOnce("skipped");
    await expect(handlers["storage.delete"](payload, { id: "o1" })).resolves.toBe("skipped");
    expect(mocks.handleStorageDeleteOutbox).toHaveBeenCalledWith(payload);
  });

  it("access.capacityReached → handleAccessCapacityReachedOutbox(payload, meta)", async () => {
    const handlers = buildOutboxHandlers();
    const payload = { eventId: "e1", accessId: "a1", reason: "capacity_reached" };
    const meta = { id: "o1" };
    mocks.handleAccessCapacityReachedOutbox.mockResolvedValueOnce("processed");
    await expect(handlers["access.capacityReached"](payload, meta)).resolves.toBe("processed");
    expect(mocks.handleAccessCapacityReachedOutbox).toHaveBeenCalledWith(payload, meta);
  });

  it("email.triggered → queueTriggeredEmail(trigger, eventId, registration)", async () => {
    const handlers = buildOutboxHandlers();
    const registration = { id: "r1", email: "a@b.c", firstName: "A", lastName: "B" };
    mocks.queueTriggeredEmail.mockResolvedValue(true);

    const outcome = await handlers["email.triggered"](
      {
        trigger: "REGISTRATION_CREATED",
        eventId: "ev1",
        registration,
      },
      { id: "evt-1" },
    );

    expect(mocks.queueTriggeredEmail).toHaveBeenCalledWith(
      "REGISTRATION_CREATED",
      "ev1",
      registration,
    );
    expect(outcome).toBe("processed");
  });

  it("maps a false queue result to 'skipped' (no active template)", async () => {
    const handlers = buildOutboxHandlers();
    mocks.queueTriggeredEmail.mockResolvedValue(false);
    const outcome = await handlers["email.triggered"](
      {
        trigger: "REGISTRATION_CREATED",
        eventId: "ev1",
        registration: { id: "r1", email: "a@b.c", firstName: null, lastName: null },
      },
      { id: "evt-2" },
    );
    expect(outcome).toBe("skipped");
  });

  it("email.sponsorship → queueSponsorshipEmail(trigger, eventId, input)", async () => {
    const handlers = buildOutboxHandlers();
    const input = { recipientEmail: "s@p.c", context: {} };
    mocks.queueSponsorshipEmail.mockResolvedValue(true);

    const outcome = await handlers["email.sponsorship"](
      {
        trigger: "SPONSORSHIP_BATCH_SUBMITTED",
        eventId: "ev2",
        input,
      },
      { id: "evt-3" },
    );

    expect(mocks.queueSponsorshipEmail).toHaveBeenCalledWith(
      "SPONSORSHIP_BATCH_SUBMITTED",
      "ev2",
      input,
    );
    expect(outcome).toBe("processed");
  });

  it("email.abstract → queueAbstractEmail(payload, dedupeKey) using the outbox event's own id", async () => {
    const handlers = buildOutboxHandlers();
    const payload = { trigger: "ABSTRACT_DECISION", abstractId: "ab1" };
    mocks.queueAbstractEmail.mockResolvedValue(true);

    const outcome = await handlers["email.abstract"](payload, { id: "evt-1" });

    expect(mocks.queueAbstractEmail).toHaveBeenCalledWith(payload, "evt-1");
    expect(outcome).toBe("processed");
  });

  it("email.abstract returns 'skipped' when no template resolves", async () => {
    const handlers = buildOutboxHandlers();
    mocks.queueAbstractEmail.mockResolvedValue(false);
    const outcome = await handlers["email.abstract"](
      { trigger: "ABSTRACT_DECISION", abstractId: "ab1" },
      { id: "evt-2" },
    );
    expect(outcome).toBe("skipped");
  });

  it("email.abstract passes a distinct outbox event id through as a distinct dedupe key", async () => {
    const handlers = buildOutboxHandlers();
    mocks.queueAbstractEmail.mockResolvedValue(true);
    const payload = { trigger: "ABSTRACT_ACCEPTED", abstractId: "ab1" };

    await handlers["email.abstract"](payload, { id: "evt-a" });
    await handlers["email.abstract"](payload, { id: "evt-b" });

    expect(mocks.queueAbstractEmail).toHaveBeenNthCalledWith(1, payload, "evt-a");
    expect(mocks.queueAbstractEmail).toHaveBeenNthCalledWith(2, payload, "evt-b");
  });
});
