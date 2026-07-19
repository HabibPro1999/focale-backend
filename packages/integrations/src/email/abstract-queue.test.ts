import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock the @app/db fn layer (queries are DB-tier) -------------------------
vi.mock("@app/db", () => ({
  getAbstractForEmailContext: vi.fn(),
  findAbstractEmailTemplate: vi.fn(),
  pgUniqueViolation: vi.fn(() => null),
  EMAIL_LOGS_DEDUPE_KEY_ACTIVE_KEY: "email_logs_dedupe_key_active_key",
}));

const queueEmailMock = vi.hoisted(() => vi.fn());
vi.mock("./queue", () => ({ queueEmail: queueEmailMock }));

import {
  getAbstractForEmailContext,
  findAbstractEmailTemplate,
  pgUniqueViolation,
} from "@app/db";
import { queueAbstractEmail } from "./abstract-queue";

const mocked = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

function abstract(overrides: Record<string, unknown> = {}) {
  return {
    id: "ab-1",
    authorFirstName: "Jane",
    authorLastName: "Doe",
    authorEmail: "jane@x.com",
    content: { title: "My Abstract" },
    status: "SUBMITTED",
    requestedType: "ORAL_COMMUNICATION",
    finalType: null,
    code: null,
    editToken: "tok",
    linkBaseUrl: "https://events.example.com",
    eventId: "ev-1",
    event: { name: "Congress", slug: "congress", clientId: "client-1" },
    config: {
      submissionStartAt: null,
      submissionDeadline: null,
      editingDeadline: null,
      scoringStartAt: null,
      scoringDeadline: null,
      finalFileDeadline: null,
      finalFileUploadEnabled: false,
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked(getAbstractForEmailContext).mockResolvedValue(abstract());
  mocked(pgUniqueViolation).mockReturnValue(null);
});

describe("queueAbstractEmail — template path (unchanged)", () => {
  it("queues via the found template, no fallback markers in contextSnapshot", async () => {
    mocked(findAbstractEmailTemplate).mockResolvedValue({ id: "tmpl-1" });
    queueEmailMock.mockResolvedValue({ ok: true, log: { id: "log-1" } });

    const out = await queueAbstractEmail({
      trigger: "ABSTRACT_SUBMISSION_ACK",
      abstractId: "ab-1",
    });

    expect(out).toBe(true);
    const call = queueEmailMock.mock.calls[0][0];
    expect(call.templateId).toBe("tmpl-1");
    expect(call.contextSnapshot._fallbackSubject).toBeUndefined();
    expect(call.contextSnapshot._fallbackPlainBody).toBeUndefined();
  });
});

describe("queueAbstractEmail — no-template fallback (C1/N4)", () => {
  beforeEach(() => {
    mocked(findAbstractEmailTemplate).mockResolvedValue(null);
  });

  it("builds a fallback subject/body and queues with no templateId", async () => {
    queueEmailMock.mockResolvedValue({ ok: true, log: { id: "log-1" } });

    const out = await queueAbstractEmail({
      trigger: "ABSTRACT_ACCEPTED",
      abstractId: "ab-1",
    });

    expect(out).toBe(true);
    expect(queueEmailMock).toHaveBeenCalledTimes(1);
    const call = queueEmailMock.mock.calls[0][0];
    expect(call.templateId).toBeUndefined();
    expect(typeof call.contextSnapshot._fallbackSubject).toBe("string");
    expect(call.contextSnapshot._fallbackSubject).toContain("{{congressName}}");
    expect(typeof call.contextSnapshot._fallbackPlainBody).toBe("string");
    expect(call.contextSnapshot._fallbackPlainBody).toContain("{{authorName}}");
    // Real context vars are still present alongside the fallback markers.
    expect(call.contextSnapshot.authorName).toBe("Jane Doe");
  });

  it("covers all 8 non-invite triggers with fallback text", async () => {
    queueEmailMock.mockResolvedValue({ ok: true, log: { id: "log-1" } });
    const triggers = [
      "ABSTRACT_SUBMISSION_ACK",
      "ABSTRACT_EDIT_ACK",
      "ABSTRACT_DECISION",
      "ABSTRACT_ACCEPTED",
      "ABSTRACT_REJECTED",
      "ABSTRACT_COMMITTEE_COMMENTS",
      "ABSTRACT_SCORE_DIVERGENCE",
      "ABSTRACT_FINAL_FILE_REQUEST",
    ] as const;

    for (const trigger of triggers) {
      await expect(
        queueAbstractEmail({ trigger, abstractId: "ab-1" }),
      ).resolves.toBe(true);
    }
    expect(queueEmailMock).toHaveBeenCalledTimes(triggers.length);
  });

  it("throws (loud failure) for a trigger with no fallback text (ABSTRACT_COMMITTEE_INVITE)", async () => {
    await expect(
      queueAbstractEmail({
        trigger: "ABSTRACT_COMMITTEE_INVITE",
        abstractId: "ab-1",
      }),
    ).rejects.toThrow(/No template or fallback/);
    expect(queueEmailMock).not.toHaveBeenCalled();
  });

  it("still applies the ABSTRACT_SUBMISSION_ACK dedupe guard via the fallback path", async () => {
    queueEmailMock.mockRejectedValue(new Error("23505"));
    mocked(pgUniqueViolation).mockReturnValue({
      constraint: "email_logs_abstract_submission_ack_active_key",
    });

    const out = await queueAbstractEmail({
      trigger: "ABSTRACT_SUBMISSION_ACK",
      abstractId: "ab-1",
    });
    expect(out).toBe(false);
  });
});

describe("queueAbstractEmail — H6 per-delivery idempotency", () => {
  beforeEach(() => {
    mocked(findAbstractEmailTemplate).mockResolvedValue({ id: "tmpl-1" });
  });

  it("passes the dedupeKey through to queueEmail", async () => {
    queueEmailMock.mockResolvedValue({ ok: true, log: { id: "log-1" } });
    await queueAbstractEmail(
      { trigger: "ABSTRACT_DECISION", abstractId: "ab-1" },
      "outbox:evt-1",
    );
    expect(queueEmailMock.mock.calls[0][0]).toMatchObject({
      dedupeKey: "outbox:evt-1",
    });
  });

  it("a dedupe-key conflict (redelivery) is treated as an idempotent success, not a skip", async () => {
    queueEmailMock.mockResolvedValue({
      ok: false,
      conflictIndex: "email_logs_dedupe_key_active_key",
    });
    const out = await queueAbstractEmail(
      { trigger: "ABSTRACT_DECISION", abstractId: "ab-1" },
      "outbox:evt-1",
    );
    expect(out).toBe(true);
  });

  it("a distinct dedupeKey (new outbox event) still sends", async () => {
    queueEmailMock.mockResolvedValue({ ok: true, log: { id: "log-2" } });
    const out = await queueAbstractEmail(
      { trigger: "ABSTRACT_DECISION", abstractId: "ab-1" },
      "outbox:evt-2",
    );
    expect(out).toBe(true);
    expect(queueEmailMock).toHaveBeenCalledTimes(1);
  });

  it("a non-dedupe conflict index still skips (false)", async () => {
    queueEmailMock.mockResolvedValue({
      ok: false,
      conflictIndex: "email_logs_template_recipient_trigger_active_key",
    });
    const out = await queueAbstractEmail(
      { trigger: "ABSTRACT_DECISION", abstractId: "ab-1" },
      "outbox:evt-1",
    );
    expect(out).toBe(false);
  });
});

describe("queueAbstractEmail — abstract not found", () => {
  it("returns false without calling queueEmail", async () => {
    mocked(getAbstractForEmailContext).mockResolvedValue(null);
    const out = await queueAbstractEmail({
      trigger: "ABSTRACT_DECISION",
      abstractId: "gone",
    });
    expect(out).toBe(false);
    expect(queueEmailMock).not.toHaveBeenCalled();
  });
});
