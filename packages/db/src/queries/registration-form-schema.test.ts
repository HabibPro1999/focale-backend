import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { forms } from "../schema/forms";
import { findRegistrationFormSchema } from "./forms";
import { getRegistrationFormSchemaForEvent } from "./registrations";

const dialect = new PgDialect({ casing: "snake_case" });

describe("registration form schema query parity", () => {
  it.each([{ rows: [] }, { rows: [{ schema: null }] }, { rows: [{ schema: { steps: [] } }] }])(
    "preserves SQL, executor and result for $rows", async ({ rows }) => {
      const query = {
        select: vi.fn().mockReturnThis(), from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue(rows),
      };
      const executor = query as unknown as DbExecutor;
      for (const read of [findRegistrationFormSchema, getRegistrationFormSchemaForEvent]) {
        expect(await read("event-1", executor)).toStrictEqual(rows[0] ?? null);
      }
      expect(query.select.mock.calls).toEqual([[{ schema: forms.schema }], [{ schema: forms.schema }]]);
      expect(query.from.mock.calls).toEqual([[forms], [forms]]);
      const predicates = query.where.mock.calls.map(([where]) => dialect.sqlToQuery(where as SQL));
      expect(predicates[0]).toStrictEqual(predicates[1]);
      expect(predicates[0]).toMatchObject({
        sql: '("forms"."event_id" = $1 and "forms"."type" = $2)',
        params: ["event-1", "REGISTRATION"],
      });
      expect(query.limit.mock.calls).toEqual([[1], [1]]);
    },
  );
});
