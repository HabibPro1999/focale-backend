import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const database = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../client", () => ({
  getDb: () => drizzle({ client: database as unknown as Pool, casing: "snake_case" }),
}));
import { getFinancialSummaryAggregates } from "./reports";

beforeEach(() => database.query.mockReset().mockResolvedValue({ rows: [] }));

const startDate = new Date("2026-01-01T00:00:00.000Z");
const endDate = new Date("2026-01-31T23:59:59.000Z");

describe("financial report SQL boundaries", () => {
  it.each([
    { startDate: null, endDate: null },
    { startDate, endDate },
  ])("keeps all six reads and their scope with dates %j", async (range) => {
    const result = await getFinancialSummaryAggregates("event-1", range);
    const queries = database.query.mock.calls.map(([query, params]) => ({ sql: query.text as string, params }));
    expect(queries).toHaveLength(6);
    for (const query of queries) {
      expect(query.sql).toContain('"registrations"."event_id" = $1');
      const scope = ["event-1", ...(range.startDate ? [startDate.toISOString(), endDate.toISOString()] : [])];
      expect(query.params.slice(0, scope.length)).toEqual(scope);
      if (range.startDate) {
        expect(query.sql).toContain('"registrations"."submitted_at" >= $2');
        expect(query.sql).toContain('"registrations"."submitted_at" <= $3');
      } else {
        expect(query.sql).not.toContain('"submitted_at"');
      }
    }
    for (const query of queries.slice(0, 4)) expect(query.sql).toContain('group by "registrations"."currency"');
    expect(queries[0]!.sql).not.toContain('"payment_status"');
    expect(queries[1]!.params.slice(-3)).toEqual(["PENDING", "VERIFYING", "PARTIAL"]);
    expect(queries[2]!.params.at(-1)).toBe("REFUNDED");
    expect(queries[3]!.sql).toContain('"registrations"."payment_status" != \'REFUNDED\'');
    expect(queries[4]!.sql).toContain('avg("total_amount")');
    expect(queries[4]!.sql).toContain('sum("base_amount")');
    expect(queries[4]!.sql).not.toContain("group by");
    expect(queries[4]!.sql).not.toContain('sum("total_amount")');
    expect(queries[4]!.sql).not.toContain('sum("paid_amount")');
    // The separate overall revenue sum preserves its own read snapshot and conversion.
    expect(queries[5]!.sql).toMatch(/^select sum\("paid_amount"\) from "registrations" where /);
    expect(queries[5]!.sql).toContain('"registrations"."payment_status" != \'REFUNDED\'');
    expect(queries[5]!.sql).not.toContain("group by");
    expect(result).toMatchObject({
      byCurrency: [], pendingByCurrency: [], refundedByCurrency: [], revenueByCurrency: [],
      overall: { baseAmount: 0, accessAmount: 0, discountAmount: 0, sponsorshipAmount: 0, avgTotalAmount: 0, count: 0 },
      overallRevenuePaid: 0,
    });
  });
});
