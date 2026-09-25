import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
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

const mockDb = drizzle.mock({ casing: "snake_case" });

/**
 * Fake DbExecutor for enqueue tests: builds the real drizzle insert (so the
 * rendered SQL is checked) and resolves it with `returned` instead of
 * touching a database.
 */
function makeExec(opts: { returned?: unknown[]; error?: unknown } = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const values = vi.fn();
  const insert = vi.fn((table: Parameters<typeof mockDb.insert>[0]) => {
    const builder = mockDb.insert(table);
    const realValues = builder.values.bind(builder);
    builder.values = ((v: never) => {
      values(v);
      const query = realValues(v);
      // The final builder is awaited: record its SQL and resolve without a DB.
      Object.assign(query, {
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          queries.push(query.toSQL());
          return (opts.error ? Promise.reject(opts.error) : Promise.resolve(opts.returned ?? [{ id: "new" }]))
            .then(resolve, reject);
        },
      });
      return query;
    }) as typeof builder.values;
    return builder;
  });
  return { exec: { insert } as never, insert, values, queries };
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

  it("inserts with ON CONFLICT on the partial dedupe index, repeating its predicate", async () => {
    const { exec, queries } = makeExec();
    await expect(
      enqueueOutboxEvent(exec, {
        type: "email.abstract",
        dedupeKey: "email:abstract:ACCEPTED:abstract-1",
        payload: { trigger: "ABSTRACT_ACCEPTED", abstractId: "abstract-1" },
      }),
    ).resolves.toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toMatch(
      /on conflict \("dedupe_key"\) where "dedupe_key" IS NOT NULL do nothing returning "id"$/,
    );
    // One statement: no pre-check SELECT, no SAVEPOINT.
    expect(queries[0]!.sql).not.toMatch(/savepoint/i);
  });

  it("returns false when the dedupe key already exists (nothing inserted)", async () => {
    const { exec } = makeExec({ returned: [] });
    await expect(
      enqueueOutboxEvent(exec, {
        type: "email.abstract",
        dedupeKey: "email:abstract:ACCEPTED:abstract-1",
        payload: { trigger: "ABSTRACT_ACCEPTED", abstractId: "abstract-1" },
      }),
    ).resolves.toBe(false);
  });

  it("uses the same statement without a dedupe key (NULL never conflicts)", async () => {
    const { exec, queries, values } = makeExec();
    await expect(
      enqueueOutboxEvent(exec, { type: "email.triggered", payload: { a: 1, drop: undefined } }),
    ).resolves.toBe(true);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: null, payload: { a: 1 }, maxAttempts: 5 }),
    );
    expect(queries[0]!.sql).toContain("on conflict");
  });

  it("rethrows database errors", async () => {
    const { exec } = makeExec({ error: { code: "23503" } });
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

    expect(result).toEqual({ processed: 1, skipped: 1, failed: 1, leaseLost: 0, released: 0 });

    const marks = dbMock.execute.mock.calls.map((c) => ({
      text: render(c[0] as SQL),
      params: paramsOf(c[0] as SQL),
    }));
    expect(marks.some((m) => m.params.includes("processed") && m.params.includes("PROCESSED"))).toBe(true);
    expect(marks.some((m) => m.params.includes("skipped") && m.params.includes("SKIPPED"))).toBe(true);
    const failure = marks.find((m) => m.params.includes("failed") && m.params.includes("boom"));
    expect(failure?.text).toContain(`"status" = 'FAILED'`);
    // Every terminal write is fenced by ownership.
    expect(failure?.text).toContain(`"status" = $`);
    expect(failure?.params).toEqual(expect.arrayContaining(["PROCESSING", "worker-1"]));
  });

  it("dead-letters a failing row on its last attempt", async () => {
    dbMock.execute.mockImplementation(
      routeExecute(
        [{ id: "last" }],
        [{ id: "last", type: "email.abstract", payload: {}, attemptCount: 5, maxAttempts: 5 }],
      ),
    );

    const result = await processOutboxEvents(1, { workerId: "worker-1", handlers: handlers() });

    expect(result).toMatchObject({ failed: 1 });
    const failure = dbMock.execute.mock.calls
      .map((c) => ({ text: render(c[0] as SQL), params: paramsOf(c[0] as SQL) }))
      .find((m) => m.params.includes("boom"));
    expect(failure?.text).toContain(`"status" = 'DEAD_LETTERED'`);
  });

  it("stops before the next claimed row once its signal aborts", async () => {
    const controller = new AbortController();
    const first = vi.fn(async () => {
      controller.abort();
      return "processed" as const;
    });
    const second = vi.fn().mockResolvedValue("processed");
    dbMock.execute.mockImplementation(
      routeExecute(
        [{ id: "a" }, { id: "b" }],
        [
          { id: "a", type: "first", payload: {}, attemptCount: 1, maxAttempts: 5 },
          { id: "b", type: "second", payload: {}, attemptCount: 1, maxAttempts: 5 },
        ],
      ),
    );

    const result = await processOutboxEvents(2, {
      workerId: "worker-1",
      handlers: { first, second },
      signal: controller.signal,
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    // The unstarted row goes back to the queue without an attempt penalty.
    expect(result).toEqual({ processed: 1, skipped: 0, failed: 0, leaseLost: 0, released: 1 });
    const release = dbMock.execute.mock.calls
      .map((c) => render(c[0] as SQL))
      .find((s) => s.includes("GREATEST"));
    expect(release).toContain(`"attempt_count" = GREATEST("attempt_count" - 1, 0)`);
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

    // The ownership check before the handler already fails: the handler never runs.
    expect(result).toEqual({ processed: 0, skipped: 0, failed: 0, leaseLost: 1, released: 0 });
  });

  it("counts a lease lost between the confirm and the terminal write once", async () => {
    const route = routeExecute(
      [{ id: "processed" }],
      [{ id: "processed", type: REALTIME_EMIT_TYPE, payload: {}, attemptCount: 1, maxAttempts: 5 }],
    );
    dbMock.execute.mockImplementation(async (q: SQL) => {
      // The confirm (lease extension) still owns the row; the completion misses.
      if (render(q).includes(`"processed_at"`)) return { rowCount: 0, rows: [] };
      return route(q);
    });
    const handler = vi.fn().mockResolvedValue("processed");

    const result = await processOutboxEvents(1, {
      workerId: "worker-1",
      handlers: { [REALTIME_EMIT_TYPE]: handler },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ processed: 0, skipped: 0, failed: 0, leaseLost: 1, released: 0 });
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

      // One lease extension is the ownership confirm before the handler; the
      // heartbeat adds another while the handler is still running.
      const renewals = dbMock.execute.mock.calls.filter((c) => {
        const q = c[0] as SQL;
        return (
          render(q).includes(`SET "locked_until"`) &&
          paramsOf(q).includes("slow")
        );
      });
      expect(renewals.length).toBeGreaterThanOrEqual(2);

      resolveHandler("processed");
      await processing;
    } finally {
      vi.useRealTimers();
    }
  });
});
