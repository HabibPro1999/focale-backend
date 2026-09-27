import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DbExecutor } from "../client";
import { eventAccess } from "../schema/events-access";
import {
  getCheckInReportData,
  getEventAccessNames,
  getEventSummaryData,
  getRegistrationsForModularExport,
  getSponsorshipsReportData,
} from "./reports";

function executor(results: unknown[][]) {
  const queries: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const db = {
    select: vi.fn((selection?: unknown) => {
      const rows = results[queries.length];
      if (!rows) throw new Error("Unexpected query");
      const query = {
        selection: vi.fn(() => selection),
        from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(), leftJoin: vi.fn().mockReturnThis(),
        then: vi.fn((resolve: (rows: unknown[]) => unknown) => resolve(rows)),
      };
      queries.push(query);
      return query;
    }),
  };
  return { db: db as unknown as DbExecutor, queries };
}

describe("report read mapping", () => {
  it("keeps sponsorship usage order and the empty-email null relation", async () => {
    const at = new Date("2026-01-01T12:00:00Z");
    const { db } = executor([
      [], [{ currency: "TND" }], [], [{ sponsorship: { id: "s1", coveredAccessIds: null }, batch: {} }],
      [
        { sponsorshipId: "s1", amountApplied: 10, appliedAt: at, registrationId: "r1", regEmail: "", regFirstName: "Empty", regLastName: null },
        { sponsorshipId: "s1", amountApplied: 20, appliedAt: at, registrationId: "r2", regEmail: "r@example.test", regFirstName: null, regLastName: "Last" },
      ],
    ]);
    const result = await getSponsorshipsReportData("event", undefined, db);
    expect(result.sponsorships[0].coveredAccessIds).toEqual([]);
    expect(result.sponsorships[0].usages).toStrictEqual([
      { amountApplied: 10, appliedAt: at, registration: null },
      { amountApplied: 20, appliedAt: at, registration: { firstName: null, lastName: "Last", email: "r@example.test" } },
    ]);
  });

  it("keeps the access-name projection, filter and sort order", async () => {
    const rows = [{ id: "a2", name: "Second" }, { id: "a1", name: "First" }];
    const { db, queries } = executor([rows]);
    expect(await getEventAccessNames("event", db)).toStrictEqual(rows);
    expect(queries[0].selection()).toEqual({ id: eventAccess.id, name: eventAccess.name });
    const dialect = new PgDialect({ casing: "snake_case" });
    expect(dialect.sqlToQuery(queries[0].where.mock.calls[0][0])).toMatchObject({
      sql: '"event_access"."event_id" = $1', params: ["event"],
    });
    expect(dialect.sqlToQuery(queries[0].orderBy.mock.calls[0][0]).sql)
      .toBe('"event_access"."sort_order" asc');
  });

  it("keeps the summary's access type and null-array normalization", async () => {
    const event = { name: "Conference", slug: "conf" };
    const access = [{ id: "a1", name: "Workshop", type: "WORKSHOP" }];
    const { db, queries } = executor([[event], access, [{ paymentStatus: "PAID", accessTypeIds: null }]]);
    expect(await getEventSummaryData("event", db)).toStrictEqual({
      event, accessTypes: access, registrations: [{ paymentStatus: "PAID", accessTypeIds: [] }],
    });
    expect(queries[1].selection()).toEqual({ id: eventAccess.id, name: eventAccess.name, type: eventAccess.type });
  });

  it("groups modular relations in query order without leaking registrationId", async () => {
    const at = new Date("2026-01-01T12:00:00Z");
    const tx = { type: "PAYMENT", amount: 20, method: null, reference: "ref", performedBy: null, createdAt: at };
    const { db } = executor([
      [{ id: "r1", accessTypeIds: null, droppedAccessIds: null }, { id: "r2", accessTypeIds: ["a1"], droppedAccessIds: [] }],
      [{ registrationId: "r1", accessId: "a2", checkedInAt: at }, { registrationId: "r1", accessId: "a1", checkedInAt: at }],
      [{ registrationId: "r2", ...tx }, { registrationId: "r2", ...tx, amount: 30 }],
    ]);
    expect(await getRegistrationsForModularExport("event", { needCheckIns: true, needTransactions: true }, db)).toStrictEqual([
      { id: "r1", accessTypeIds: [], droppedAccessIds: [], accessCheckIns: [{ accessId: "a2", checkedInAt: at }, { accessId: "a1", checkedInAt: at }], transactions: [] },
      { id: "r2", accessTypeIds: ["a1"], droppedAccessIds: [], accessCheckIns: [], transactions: [tx, { ...tx, amount: 30 }] },
    ]);
  });

  it("groups check-in relations without changing registration order or empty arrays", async () => {
    const at = new Date("2026-01-01T12:00:00Z");
    const { db } = executor([
      [], [], [{ id: "r2", accessTypeIds: null }, { id: "r1", accessTypeIds: ["a1"] }],
      [{ registrationId: "r1", accessId: "a1", checkedInAt: at }],
    ]);
    expect(await getCheckInReportData("event", db)).toStrictEqual({
      event: null, accessItems: [], registrations: [
        { id: "r2", accessTypeIds: [], accessCheckIns: [] },
        { id: "r1", accessTypeIds: ["a1"], accessCheckIns: [{ accessId: "a1", checkedInAt: at }] },
      ],
    });
  });
});
