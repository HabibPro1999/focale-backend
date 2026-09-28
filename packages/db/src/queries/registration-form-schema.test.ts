import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DbExecutor } from "../client";
import { configureJsonbValidation, StoredJsonError } from "../jsonb";
import { forms } from "../schema/forms";
import { getRegistrationFormSchema } from "./email";
import { findRegistrationFormSchema } from "./forms";
import { getRegistrationFormSchemaForEvent } from "./registrations";

const dialect = new PgDialect({ casing: "snake_case" });
const schema = { steps: [{ id: "step-1", title: "Contact", fields: [] }] };

function queryFor(rows: unknown[]) {
  return {
    select: vi.fn().mockReturnThis(), from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue(rows),
  };
}

afterEach(() => configureJsonbValidation(undefined));

describe("registration form schema query parity", () => {
  it.each([{ rows: [] }, { rows: [{ id: "form-1", schema }] }])("preserves SQL, executor and result for $rows", async ({ rows }) => {
    configureJsonbValidation("enforce");
    const query = queryFor(rows);
    for (const read of [findRegistrationFormSchema, getRegistrationFormSchemaForEvent]) {
      const result = await read("event-1", query as unknown as DbExecutor);
      expect(result).toStrictEqual(rows.length ? { schema } : null);
      if (result) expect(result.schema).toBe(schema);
    }
    expect(query.select.mock.calls).toEqual([
      [{ id: forms.id, schema: forms.schema }], [{ id: forms.id, schema: forms.schema }],
    ]);
    expect(query.from.mock.calls).toEqual([[forms], [forms]]);
    const predicates = query.where.mock.calls.map(([where]) => dialect.sqlToQuery(where as SQL));
    expect(predicates[0]).toStrictEqual(predicates[1]);
    expect(predicates[0]).toMatchObject({
      sql: '("forms"."event_id" = $1 and "forms"."type" = $2)',
      params: ["event-1", "REGISTRATION"],
    });
    expect(query.limit.mock.calls).toEqual([[1], [1]]);
  });

  it.each([null, false, {}])("keeps enforce-mode decoder errors for stored %j", async (invalid) => {
    configureJsonbValidation("enforce");
    const query = queryFor([{ id: "form-1", schema: invalid }]);
    for (const read of [findRegistrationFormSchema, getRegistrationFormSchemaForEvent]) {
      await expect(read("event-1", query as unknown as DbExecutor)).rejects.toMatchObject({
        name: StoredJsonError.name, column: "forms.schema", rowId: "form-1",
      });
    }
  });

  // The email variable picker's read (email.ts) returns the schema itself.
  it.each([{ rows: [] }, { rows: [{ id: "form-1", schema }] }])(
    "the email read runs the same query and returns the bare schema for $rows",
    async ({ rows }) => {
      configureJsonbValidation("enforce");
      const query = queryFor(rows);
      const reference = queryFor(rows);
      const result = await getRegistrationFormSchema(
        "event-1",
        query as unknown as DbExecutor,
      );
      await findRegistrationFormSchema("event-1", reference as unknown as DbExecutor);

      expect(result).toBe(rows.length ? schema : null);
      expect(query.select.mock.calls).toEqual(reference.select.mock.calls);
      expect(query.from.mock.calls).toEqual(reference.from.mock.calls);
      const [where] = query.where.mock.calls[0] as [SQL];
      const [referenceWhere] = reference.where.mock.calls[0] as [SQL];
      expect(dialect.sqlToQuery(where)).toStrictEqual(
        dialect.sqlToQuery(referenceWhere),
      );
      expect(query.limit.mock.calls).toEqual([[1]]);
    },
  );

  it.each([null, false, {}])(
    "the email read keeps the enforce-mode decoder error for stored %j",
    async (invalid) => {
      configureJsonbValidation("enforce");
      const query = queryFor([{ id: "form-1", schema: invalid }]);
      await expect(
        getRegistrationFormSchema("event-1", query as unknown as DbExecutor),
      ).rejects.toMatchObject({
        name: StoredJsonError.name,
        column: "forms.schema",
        rowId: "form-1",
      });
    },
  );

  it("the email read returns a warn-mode stored value as stored", async () => {
    configureJsonbValidation("warn");
    const query = queryFor([{ id: "form-1", schema: null }]);
    await expect(
      getRegistrationFormSchema("event-1", query as unknown as DbExecutor),
    ).resolves.toBeNull();
  });
});
