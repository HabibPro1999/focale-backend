import { describe, expect, it, vi, beforeEach } from "vitest";

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
  pendingT: Date | null;
  processingT: Date | null;
}) {
  const countRows = Object.entries(opts.counts).map(([status, n]) => ({
    status,
    n,
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
    });
  });

  it("unhealthy when any dead-lettered", async () => {
    stub({ counts: { DEAD_LETTERED: 1 }, pendingT: null, processingT: null });
    expect((await getOutboxHealth()).isHealthy).toBe(false);
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
