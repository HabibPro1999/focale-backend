import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dbMock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => dbMock }));
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

import { getOutboxHealth } from "./outbox";

// execute() is called in Promise.all order: counts, oldestPending, oldestProcessing.
function stub(opts: {
  counts: Partial<Record<string, number>>;
  /** Dead letters written in the last 24 h (the DEAD_LETTERED row's `recent`). */
  recentDead?: number;
  pendingT: Date | null;
  processingT: Date | null;
}) {
  const countRows = Object.entries(opts.counts).map(([status, n]) => ({
    status,
    n,
    recent: status === "DEAD_LETTERED" ? (opts.recentDead ?? n) : 0,
  }));
  // Ages are now computed in SQL (EXTRACT(EPOCH ...)); the mock returns the
  // pre-computed age in ms that the query would yield for the fixture instant.
  const ageMs = (t: Date | null) => (t ? Date.now() - t.getTime() : 0);
  dbMock.execute
    .mockResolvedValueOnce({ rows: countRows })
    .mockResolvedValueOnce({ rows: [{ age: ageMs(opts.pendingT) }] })
    .mockResolvedValueOnce({ rows: [{ age: ageMs(opts.processingT) }] });
}

describe("getOutboxHealth thresholds", () => {
  beforeEach(() => dbMock.execute.mockReset());

  it("healthy when under all limits", async () => {
    stub({
      counts: { PENDING: 5, FAILED: 2, PROCESSING: 1 },
      pendingT: new Date(),
      processingT: new Date(),
    });
    const h = await getOutboxHealth();
    expect(h.isHealthy).toBe(true);
    expect(h.counts).toEqual({
      pending: 5,
      failed: 2,
      processing: 1,
      deadLettered: 0,
      deadLetteredLast24h: 0,
    });
  });

  it("unhealthy when a row was dead-lettered in the last 24 h", async () => {
    stub({ counts: { DEAD_LETTERED: 3 }, recentDead: 1, pendingT: null, processingT: null });
    const h = await getOutboxHealth();
    expect(h.isHealthy).toBe(false);
    expect(h.counts).toMatchObject({ deadLettered: 3, deadLetteredLast24h: 1 });
  });

  it("stays healthy with only older dead letters", async () => {
    stub({ counts: { DEAD_LETTERED: 4 }, recentDead: 0, pendingT: null, processingT: null });
    const h = await getOutboxHealth();
    expect(h.isHealthy).toBe(true);
    expect(h.counts).toMatchObject({ deadLettered: 4, deadLetteredLast24h: 0 });
  });

  it("counts recent dead letters from updated_at in the last 24 h", async () => {
    stub({ counts: {}, pendingT: null, processingT: null });
    await getOutboxHealth();
    const countsSql = new PgDialect().sqlToQuery(dbMock.execute.mock.calls[0]![0] as SQL);
    expect(countsSql.sql).toContain(`"status" = 'DEAD_LETTERED'`);
    expect(countsSql.sql).toContain(`"updated_at" >= (statement_timestamp() AT TIME ZONE 'UTC') - $1::interval`);
    expect(countsSql.params).toEqual(["86400 seconds"]);
  });

  it("unhealthy when pending+failed >= 1000", async () => {
    stub({
      counts: { PENDING: 900, FAILED: 100 },
      pendingT: new Date(),
      processingT: null,
    });
    expect((await getOutboxHealth()).isHealthy).toBe(false);
  });

  it("unhealthy when oldest pending exceeds 10min", async () => {
    stub({
      counts: { PENDING: 1 },
      pendingT: new Date(Date.now() - 11 * 60 * 1000),
      processingT: null,
    });
    expect((await getOutboxHealth()).isHealthy).toBe(false);
  });

  it("unhealthy when oldest processing exceeds 2x lease (10min)", async () => {
    stub({
      counts: { PROCESSING: 1 },
      pendingT: null,
      processingT: new Date(Date.now() - 11 * 60 * 1000),
    });
    expect((await getOutboxHealth()).isHealthy).toBe(false);
  });
});
