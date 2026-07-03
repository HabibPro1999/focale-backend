import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Mock the drizzle client so processOutboxEvents' internal getDb() calls hit a
// controllable fake. enqueue takes its executor as an argument (rides the
// caller's txn), so those tests pass a fake exec directly instead.
const dbMock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../client", () => ({
  getDb: () => dbMock,
}));

vi.mock("@app/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/shared")>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    }),
  };
});

import {
  enqueueOutboxEvent,
  processOutboxEvents,
  type ProcessOutboxOptions,
} from "./outbox";
import { REALTIME_EMIT_TYPE } from "./types";

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q).sql;
const paramsOf = (q: SQL) => dialect.sqlToQuery(q).params;

/** Fake DbExecutor for enqueue tests: stubs the query builder + raw execute. */
function makeExec(opts: {
  existing?: boolean;
  insertError?: unknown;
  isTx?: boolean;
} = {}) {
  const execute = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
  const values = vi.fn(() =>
    opts.insertError
      ? Promise.reject(opts.insertError)
      : Promise.resolve(undefined),
  );
  const insert = vi.fn(() => ({ values }));
  const limit = vi.fn(() =>
    Promise.resolve(opts.existing ? [{ id: "existing" }] : []),
  );
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
  const exec = { execute, insert, select } as Record<string, unknown>;
  if (opts.isTx) exec.rollback = () => undefined;
  return { exec: exec as never, execute, insert, values };
}

const REALTIME_PAYLOAD = {
  type: "registration.created" as const,
  clientId: "client-1",
  eventId: "event-1",
  payload: { id: "registration-1" },
  ts: 123,
};

describe("enqueueOutboxEvent", () => {
  it("inserts with a serialized payload and the supplied metadata", async () => {
    const { exec, values } = makeExec();

    await enqueueOutboxEvent(exec, {
      type: REALTIME_EMIT_TYPE,
      aggregateType: "Registration",
      aggregateId: "registration-1",
      clientId: "client-1",
      eventId: "event-1",
      dedupeKey: "dedupe-1",
      payload: REALTIME_PAYLOAD,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
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
    );
  });

  it("treats a bare 23505 with a dedupe key as a dedupe hit (returns false)", async () => {
    const { exec, values } = makeExec({ insertError: { code: "23505" } });
    await expect(
      enqueueOutboxEvent(exec, {
        type: "email.abstract",
        dedupeKey: "email:abstract:ACCEPTED:abstract-1",
        payload: { trigger: "ABSTRACT_ACCEPTED", abstractId: "abstract-1" },
      }),
    ).resolves.toBe(false);
    expect(values).toHaveBeenCalledOnce();
  });

  it("treats a 23505 naming the dedupe constraint as a dedupe hit", async () => {
    const { exec } = makeExec({
      insertError: {
        code: "23505",
        constraint: "outbox_events_dedupe_key_key",
      },
    });
    await expect(
      enqueueOutboxEvent(exec, {
        type: "email.abstract",
        dedupeKey: "email:abstract:ACCEPTED:abstract-1",
        payload: { trigger: "ABSTRACT_ACCEPTED", abstractId: "abstract-1" },
      }),
    ).resolves.toBe(false);
  });

  it("wraps a transaction-scoped dedupe race in a savepoint and rolls back", async () => {
    const { exec, execute } = makeExec({
      insertError: { code: "23505" },
      isTx: true,
    });

    await expect(
      enqueueOutboxEvent(exec, {
        type: "email.abstract",
        dedupeKey: "email:abstract:ACCEPTED:abstract-1",
        payload: { trigger: "ABSTRACT_ACCEPTED", abstractId: "abstract-1" },
      }),
    ).resolves.toBe(false);

    const raw = execute.mock.calls.map((c) => render(c[0] as SQL));
    expect(raw).toEqual([
      "SAVEPOINT outbox_enqueue_dedupe",
      "ROLLBACK TO SAVEPOINT outbox_enqueue_dedupe",
      "RELEASE SAVEPOINT outbox_enqueue_dedupe",
    ]);
  });

  it("skips insertion when the dedupe key already exists", async () => {
    const { exec, insert } = makeExec({ existing: true });
    await expect(
      enqueueOutboxEvent(exec, {
        type: "email.abstract",
        dedupeKey: "email:abstract:ACCEPTED:abstract-1",
        payload: { trigger: "ABSTRACT_ACCEPTED", abstractId: "abstract-1" },
      }),
    ).resolves.toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rethrows a non-dedupe error", async () => {
    const { exec } = makeExec({ insertError: { code: "23503" } });
    await expect(
      enqueueOutboxEvent(exec, {
        type: "email.abstract",
        dedupeKey: "k",
        payload: {},
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

// ---------------------------------------------------------------------------

const handlers = (): ProcessOutboxOptions["handlers"] => ({
  [REALTIME_EMIT_TYPE]: vi.fn().mockResolvedValue("processed"),
  "email.triggered": vi.fn().mockResolvedValue("skipped"),
  "email.abstract": vi.fn().mockRejectedValue(new Error("boom")),
});

/** Route each execute() call by rendered SQL to a canned result. */
function routeExecute(
  claimedIds: Array<{ id: string }>,
  eventRows: unknown[],
  markCount = 1,
) {
  return async (q: SQL) => {
    const s = render(q);
    if (s.includes("FOR UPDATE SKIP LOCKED")) {
      return { rowCount: claimedIds.length, rows: claimedIds };
    }
    if (s.includes("SELECT")) return { rowCount: eventRows.length, rows: eventRows };
    // recover + mark UPDATEs
    return { rowCount: markCount, rows: markCount ? [{ id: "x" }] : [] };
  };
}

describe("processOutboxEvents", () => {
  beforeEach(() => {
    dbMock.execute.mockReset();
  });

  it("marks processed, skipped, and failed rows and tallies each", async () => {
    dbMock.execute.mockImplementation(
      routeExecute(
        [{ id: "processed" }, { id: "skipped" }, { id: "failed" }],
        [
          { id: "processed", type: REALTIME_EMIT_TYPE, payload: {}, attemptCount: 1, maxAttempts: 5 },
          { id: "skipped", type: "email.triggered", payload: {}, attemptCount: 1, maxAttempts: 5 },
          { id: "failed", type: "email.abstract", payload: {}, attemptCount: 1, maxAttempts: 5 },
        ],
      ),
    );

    const result = await processOutboxEvents(3, {
      workerId: "worker-1",
      handlers: handlers(),
    });

    expect(result).toEqual({ processed: 1, skipped: 1, failed: 1, leaseLost: 0 });

    const marks = dbMock.execute.mock.calls.map((c) => paramsOf(c[0] as SQL));
    expect(marks.some((p) => p.includes("processed") && p.includes("PROCESSED"))).toBe(true);
    expect(marks.some((p) => p.includes("skipped") && p.includes("SKIPPED"))).toBe(true);
    expect(marks.some((p) => p.includes("failed") && p.includes("FAILED"))).toBe(true);
  });

  it("claims only realtime rows for the realtime scope", async () => {
    dbMock.execute.mockImplementation(routeExecute([], []));

    await processOutboxEvents(3, {
      workerId: "worker-1",
      scope: "realtime",
      handlers: handlers(),
    });

    const claim = dbMock.execute.mock.calls
      .map((c) => render(c[0] as SQL))
      .find((s) => s.includes("FOR UPDATE SKIP LOCKED"));
    expect(claim).toContain(`AND "type" = '${REALTIME_EMIT_TYPE}'`);
  });

  it("excludes realtime rows for the background scope", async () => {
    dbMock.execute.mockImplementation(routeExecute([], []));

    await processOutboxEvents(3, {
      workerId: "worker-1",
      scope: "background",
      handlers: handlers(),
    });

    const claim = dbMock.execute.mock.calls
      .map((c) => render(c[0] as SQL))
      .find((s) => s.includes("FOR UPDATE SKIP LOCKED"));
    expect(claim).toContain(`AND "type" <> '${REALTIME_EMIT_TYPE}'`);
  });

  it("reports a lease loss when the terminal write affects no rows", async () => {
    dbMock.execute.mockImplementation(
      routeExecute(
        [{ id: "processed" }],
        [{ id: "processed", type: REALTIME_EMIT_TYPE, payload: {}, attemptCount: 1, maxAttempts: 5 }],
        0,
      ),
    );

    const result = await processOutboxEvents(1, {
      workerId: "worker-1",
      handlers: handlers(),
    });

    expect(result).toEqual({ processed: 0, skipped: 0, failed: 0, leaseLost: 1 });
  });

  it("renews the lease while a handler is in flight", async () => {
    vi.useFakeTimers();
    try {
      let resolveHandler!: (v: "processed") => void;
      const inflight = new Promise<"processed">((r) => {
        resolveHandler = r;
      });
      dbMock.execute.mockImplementation(
        routeExecute(
          [{ id: "slow" }],
          [{ id: "slow", type: REALTIME_EMIT_TYPE, payload: {}, attemptCount: 1, maxAttempts: 5 }],
        ),
      );

      const processing = processOutboxEvents(1, {
        workerId: "worker-1",
        leaseMs: 2_000,
        handlers: { [REALTIME_EMIT_TYPE]: () => inflight },
      });

      await vi.waitFor(() => {
        const sawSelect = dbMock.execute.mock.calls.some((c) =>
          render(c[0] as SQL).includes("SELECT"),
        );
        expect(sawSelect).toBe(true);
      });
      await vi.advanceTimersByTimeAsync(1_000);

      const renewed = dbMock.execute.mock.calls.some((c) => {
        const q = c[0] as SQL;
        return (
          render(q).includes(`SET "locked_until"`) &&
          paramsOf(q).includes("slow")
        );
      });
      expect(renewed).toBe(true);

      resolveHandler("processed");
      await processing;
    } finally {
      vi.useRealTimers();
    }
  });
});
