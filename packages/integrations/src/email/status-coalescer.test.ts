import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getDb: vi.fn(() => ({ db: true })),
  getEmailLogRealtimeTargets: vi.fn(),
  enqueueRealtimeOutboxEvent: vi.fn(),
}));
vi.mock("@app/db", () => db);

import {
  EMAIL_STATUS_COALESCE_MS,
  coalesceEmailStatusChanges,
  emitEmailLogRealtimeEvents,
  type EmailStatusChange,
} from "./status-coalescer";

describe("coalesceEmailStatusChanges", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits each email's latest status once per 250 ms window, as one batch", async () => {
    const emit = vi.fn(async (_changes: EmailStatusChange[]) => undefined);
    const { listener } = coalesceEmailStatusChanges(emit);
    expect(EMAIL_STATUS_COALESCE_MS).toBe(250);

    listener("log-1", "QUEUED");
    listener("log-2", "QUEUED");
    await vi.advanceTimersByTimeAsync(100);
    listener("log-1", "SENDING");
    listener("log-1", "SENT");
    await vi.advanceTimersByTimeAsync(149);
    expect(emit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(emit.mock.calls).toEqual([
      [
        [
          { emailLogId: "log-1", status: "SENT" },
          { emailLogId: "log-2", status: "QUEUED" },
        ],
      ],
    ]);

    // A later change opens a new window.
    listener("log-2", "SENT");
    await vi.advanceTimersByTimeAsync(250);
    expect(emit.mock.calls.at(-1)).toEqual([[{ emailLogId: "log-2", status: "SENT" }]]);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("emits windows in order, never overlapping a slow emit", async () => {
    const order: string[] = [];
    let release!: () => void;
    const emit = vi.fn(async (changes: EmailStatusChange[]) => {
      if (changes[0]!.status === "SENDING") await new Promise<void>((r) => (release = r));
      order.push(...changes.map((c) => `${c.emailLogId}:${c.status}`));
    });
    const { listener } = coalesceEmailStatusChanges(emit);

    listener("log-1", "SENDING");
    await vi.advanceTimersByTimeAsync(250);
    listener("log-1", "SENT");
    await vi.advanceTimersByTimeAsync(250);
    expect(order).toEqual([]);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["log-1:SENDING", "log-1:SENT"]);
  });

  it("flush emits pending changes at once and waits for them", async () => {
    const emit = vi.fn(async (_changes: EmailStatusChange[]) => undefined);
    const { listener, flush } = coalesceEmailStatusChanges(emit);
    listener("log-1", "FAILED");
    await flush();
    expect(emit).toHaveBeenCalledWith([{ emailLogId: "log-1", status: "FAILED" }]);
    // The window's timer was cleared: nothing is emitted twice.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emit).toHaveBeenCalledOnce();
    await expect(flush()).resolves.toBeUndefined();
  });

  it("logs and drops a failed window, then keeps emitting", async () => {
    const emit = vi.fn(async (changes: EmailStatusChange[]) => {
      if (changes[0]!.emailLogId === "log-1") throw new Error("db down");
    });
    const { listener, flush } = coalesceEmailStatusChanges(emit);
    listener("log-1", "SENT");
    await expect(flush()).resolves.toBeUndefined();
    listener("log-2", "SENT");
    await flush();
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe("emitEmailLogRealtimeEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.enqueueRealtimeOutboxEvent.mockResolvedValue(true);
  });

  const targets = new Map([
    ["log-1", { clientId: "c1", eventId: "e1", registrationId: "r1" }],
    ["log-2", { clientId: "c1", eventId: "e1", registrationId: "r2" }],
    ["log-3", { clientId: "c1", eventId: "e1", registrationId: null }],
    ["log-4", { clientId: "c2", eventId: "e9", registrationId: "r4" }],
  ]);

  it("emits one event per (tenant, event, status), listing several logs in ids", async () => {
    db.getEmailLogRealtimeTargets.mockResolvedValue(targets);
    await emitEmailLogRealtimeEvents([
      { emailLogId: "log-1", status: "SENT" },
      { emailLogId: "log-2", status: "SENT" },
      { emailLogId: "log-3", status: "SENT" },
      { emailLogId: "log-4", status: "SENT" },
      { emailLogId: "log-5", status: "SENT" }, // no target: skipped
    ]);

    expect(db.getEmailLogRealtimeTargets).toHaveBeenCalledWith(["log-1", "log-2", "log-3", "log-4", "log-5"]);
    const events = db.enqueueRealtimeOutboxEvent.mock.calls.map((c) => c[1]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "emailLog.statusChanged",
        clientId: "c1",
        eventId: "e1",
        payload: { id: "log-1", status: "SENT", ids: ["log-1", "log-2", "log-3"] },
      }),
      expect.objectContaining({
        type: "emailLog.statusChanged",
        clientId: "c2",
        eventId: "e9",
        payload: { id: "log-4", status: "SENT", registrationId: "r4" },
      }),
    ]);
  });

  it("keeps different statuses apart and the single-log shape unchanged", async () => {
    db.getEmailLogRealtimeTargets.mockResolvedValue(targets);
    await emitEmailLogRealtimeEvents([
      { emailLogId: "log-1", status: "SENT" },
      { emailLogId: "log-2", status: "FAILED" },
      { emailLogId: "log-3", status: "SENT" },
    ]);
    const payloads = db.enqueueRealtimeOutboxEvent.mock.calls.map((c) => c[1].payload);
    expect(payloads).toEqual([
      { id: "log-1", status: "SENT", ids: ["log-1", "log-3"] },
      { id: "log-2", status: "FAILED", registrationId: "r2" },
    ]);
  });

  it("resolves targets in chunks of 500 and keeps going when one enqueue fails", async () => {
    const changes = Array.from({ length: 1_001 }, (_, i) => ({ emailLogId: `log-${i}`, status: "SENT" }));
    db.getEmailLogRealtimeTargets.mockImplementation(async (ids: string[]) =>
      new Map(ids.map((id) => [id, { clientId: id === "log-0" ? "c0" : "c1", eventId: "e1", registrationId: null }])),
    );
    db.enqueueRealtimeOutboxEvent.mockRejectedValueOnce(new Error("db down"));
    await emitEmailLogRealtimeEvents(changes);
    expect(db.getEmailLogRealtimeTargets.mock.calls.map((c) => c[0].length)).toEqual([500, 500, 1]);
    expect(db.enqueueRealtimeOutboxEvent).toHaveBeenCalledTimes(2);
    expect(db.enqueueRealtimeOutboxEvent.mock.calls[1]![1].payload.ids).toHaveLength(1_000);
  });
});
