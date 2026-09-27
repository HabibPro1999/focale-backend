import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { getRegistrationsForExport } from "./reports";

const dialect = new PgDialect({ casing: "snake_case" });

describe("report registration filters", () => {
  it("keeps predicate/parameter order and ignores a role property outside the export contract", async () => {
    const query = {
      select: vi.fn().mockReturnThis(), from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockResolvedValue([]),
    };
    const filters = { paymentStatus: "PAID", paymentMethod: "CASH", role: "SPEAKER",
      startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-02-01T00:00:00.000Z" };
    await getRegistrationsForExport("event-1", filters, query as unknown as DbExecutor);
    const where = dialect.sqlToQuery(query.where.mock.calls[0][0] as SQL);
    expect(where.sql).toBe('(\"registrations\".\"event_id\" = $1 and \"registrations\".\"payment_status\" = $2 and \"registrations\".\"payment_method\" = $3 and \"registrations\".\"submitted_at\" >= $4 and \"registrations\".\"submitted_at\" <= $5)');
    expect(where.params).toEqual(["event-1", "PAID", "CASH", filters.startDate, filters.endDate]);
    expect(dialect.sqlToQuery(query.orderBy.mock.calls[0][0] as SQL).sql).toBe('"registrations"."submitted_at" desc');
  });
});
