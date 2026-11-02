import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { buildRegistrationWhere } from "./registrations";
import { registrationsAfter, registrationsAfterAscending } from "./reports";

const dialect = new PgDialect({ casing: "snake_case" });
const render = (sql: SQL) => dialect.sqlToQuery(sql);

describe("registration export keyset (3.7)", () => {
  it("continues after (submitted_at, id) in DESC order, bounded for the index", () => {
    const { sql, params } = render(
      registrationsAfter({ submittedAt: new Date("2026-09-01T08:00:00.123Z"), id: "reg-9" }),
    );

    expect(sql).toBe(
      '("registrations"."submitted_at" <= $1 and ("registrations"."submitted_at" < $2 or "registrations"."id" < $3))',
    );
    // Bound through the column encoder: the UTC instant, whatever the process time zone.
    expect(params).toEqual(["2026-09-01T08:00:00.123Z", "2026-09-01T08:00:00.123Z", "reg-9"]);
  });
});

describe("check-in keyset (3.7b)", () => {
  it("continues after (submitted_at, id) in ASC order, the mirror of the export keyset", () => {
    const { sql, params } = render(
      registrationsAfterAscending({ submittedAt: new Date("2026-09-01T08:00:00.123Z"), id: "reg-9" }),
    );

    expect(sql).toBe(
      '("registrations"."submitted_at" >= $1 and ("registrations"."submitted_at" > $2 or "registrations"."id" > $3))',
    );
    expect(params).toEqual(["2026-09-01T08:00:00.123Z", "2026-09-01T08:00:00.123Z", "reg-9"]);
  });
});

describe("buildRegistrationWhere (3.7: one builder for list, stats and exports)", () => {
  it("bounds submitted_at inclusively with only the dates given", () => {
    const both = render(
      buildRegistrationWhere("event-1", {
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: new Date("2026-01-31T23:59:59.000Z"),
      }),
    );
    expect(both.sql).toBe(
      '("registrations"."event_id" = $1 and "registrations"."submitted_at" >= $2 and "registrations"."submitted_at" <= $3)',
    );
    expect(both.params).toEqual(["event-1", "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.000Z"]);

    const endOnly = render(buildRegistrationWhere("event-1", { endDate: "2026-01-31T00:00:00.000Z" }));
    expect(endOnly.sql).not.toContain(">=");
    expect(endOnly.sql).toContain('"submitted_at" <= $2');
  });

  it("combines status, method, role and search", () => {
    const { sql, params } = render(
      buildRegistrationWhere("event-1", {
        paymentStatus: "PAID",
        paymentMethod: "CASH",
        role: "SPEAKER",
        search: "Mehdi",
      }),
    );
    expect(sql).toContain('"payment_status" = $2');
    expect(sql).toContain('"payment_method" = $3');
    expect(sql).toContain('"registration_role" = $4');
    expect(params.slice(0, 4)).toEqual(["event-1", "PAID", "CASH", "SPEAKER"]);
    expect(params.slice(4)).toEqual(Array(5).fill("%Mehdi%"));
  });

  it("is just the event scope without filters", () => {
    expect(render(buildRegistrationWhere("event-1")).sql).toBe('"registrations"."event_id" = $1');
  });
});
