import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  queueTriggeredEmail: vi.fn(),
  queueSponsorshipEmail: vi.fn(),
  queueAbstractEmail: vi.fn(),
}));

vi.mock("@app/shared", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@app/integrations", () => ({
  queueTriggeredEmail: mocks.queueTriggeredEmail,
  queueSponsorshipEmail: mocks.queueSponsorshipEmail,
  queueAbstractEmail: mocks.queueAbstractEmail,
}));

// @app/db only supplies types + processOutboxEvents (unused here); stub it so
// importing the job module never touches a real database client.
vi.mock("@app/db", () => ({ processOutboxEvents: vi.fn() }));

import { buildOutboxHandlers } from "./outbox.job";

describe("outbox handler registry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers exactly the three background email handlers (no realtime.emit)", () => {
    const handlers = buildOutboxHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "email.abstract",
      "email.sponsorship",
      "email.triggered",
    ]);
    expect(handlers["realtime.emit"]).toBeUndefined();
  });

  it("email.triggered → queueTriggeredEmail(trigger, eventId, registration)", async () => {
    const handlers = buildOutboxHandlers();
    const registration = { id: "r1", email: "a@b.c", firstName: "A", lastName: "B" };
    mocks.queueTriggeredEmail.mockResolvedValue(true);

    const outcome = await handlers["email.triggered"]({
      trigger: "REGISTRATION_CREATED",
      eventId: "ev1",
      registration,
    });

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
    const outcome = await handlers["email.triggered"]({
      trigger: "REGISTRATION_CREATED",
      eventId: "ev1",
      registration: { id: "r1", email: "a@b.c", firstName: null, lastName: null },
    });
    expect(outcome).toBe("skipped");
  });

  it("email.sponsorship → queueSponsorshipEmail(trigger, eventId, input)", async () => {
    const handlers = buildOutboxHandlers();
    const input = { recipientEmail: "s@p.c", context: {} };
    mocks.queueSponsorshipEmail.mockResolvedValue(true);

    const outcome = await handlers["email.sponsorship"]({
      trigger: "SPONSORSHIP_BATCH_SUBMITTED",
      eventId: "ev2",
      input,
    });

    expect(mocks.queueSponsorshipEmail).toHaveBeenCalledWith(
      "SPONSORSHIP_BATCH_SUBMITTED",
      "ev2",
      input,
    );
    expect(outcome).toBe("processed");
  });

  it("email.abstract → queueAbstractEmail(payload)", async () => {
    const handlers = buildOutboxHandlers();
    const payload = { trigger: "ABSTRACT_DECISION", abstractId: "ab1" };
    mocks.queueAbstractEmail.mockResolvedValue(true);

    const outcome = await handlers["email.abstract"](payload);

    expect(mocks.queueAbstractEmail).toHaveBeenCalledWith(payload);
    expect(outcome).toBe("processed");
  });

  it("email.abstract returns 'skipped' when no template resolves", async () => {
    const handlers = buildOutboxHandlers();
    mocks.queueAbstractEmail.mockResolvedValue(false);
    const outcome = await handlers["email.abstract"]({
      trigger: "ABSTRACT_DECISION",
      abstractId: "ab1",
    });
    expect(outcome).toBe("skipped");
  });
});
