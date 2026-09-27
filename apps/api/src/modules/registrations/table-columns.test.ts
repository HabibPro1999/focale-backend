import { describe, expect, it, vi } from "vitest";
import {
  getRegistrationTableColumns as getReportColumns,
  type DbExecutor,
} from "@app/db";
import { getRegistrationTableColumns as getGridColumns } from "./table-columns";

const defaults = [
  { id: "email", label: "Email", type: "email" },
  { id: "firstName", label: "First Name", type: "text" },
  { id: "lastName", label: "Last Name", type: "text" },
  { id: "phone", label: "Phone", type: "phone" },
  { id: "paymentStatus", label: "Payment", type: "payment" },
  { id: "totalAmount", label: "Amount", type: "currency" },
  { id: "createdAt", label: "Registered", type: "datetime" },
];

/** Both real query paths run against the same schema, without a DB connection. */
async function columnsFor(schema: unknown, absent = false) {
  const query = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(absent ? [] : [{ schema }]),
  };
  const exec = query as unknown as DbExecutor;
  const grid = await getGridColumns("event-1", exec);
  const report = await getReportColumns("event-1", exec);
  expect(report).toStrictEqual(grid);
  expect(query.select).toHaveBeenCalledTimes(2);
  expect(query.limit.mock.calls).toEqual([[1], [1]]);
  return grid;
}

describe("registration grid/export column parity", () => {
  it("uses default columns when there is no registration form", async () => {
    expect(await columnsFor(undefined, true)).toStrictEqual({
      formColumns: [], fixedColumns: defaults,
    });
  });

  it.each([null, false, { steps: [] }])("keeps defaults for %j", async (schema) => {
    expect(await columnsFor(schema)).toStrictEqual({
      formColumns: [], fixedColumns: defaults,
    });
  });

  it("uses typed first-step contacts and keeps later-step contacts in form order", async () => {
    const result = await columnsFor({ steps: [
      { fields: [
        { id: "heading", type: "heading", label: "Contact" },
        { id: "email", type: "email", label: "Courriel" },
        { id: "first", type: "firstName", label: "Prénom" },
        { id: "last", type: "lastName", label: "Nom" },
        { id: "phone", type: "phone", label: "Téléphone" },
        { id: "company", type: "text", label: "Société" },
        { id: "paragraph", type: "paragraph" },
      ] },
      { fields: [
        { id: "email", type: "email", label: "Second email" },
        { id: "anonymous", type: "number" },
      ] },
    ] });
    expect(result).toStrictEqual({
      fixedColumns: [
        { id: "email", label: "Courriel", type: "email" },
        { id: "firstName", label: "Prénom", type: "text" },
        { id: "lastName", label: "Nom", type: "text" },
        { id: "phone", label: "Téléphone", type: "phone" },
        ...defaults.slice(4),
      ],
      formColumns: [
        { id: "company", label: "Société", type: "text", options: undefined },
        { id: "email", label: "Second email", type: "email", options: undefined },
        { id: "anonymous", label: "anonymous", type: "number", options: undefined },
      ],
    });
  });

  it("falls back to the first two plain text fields and preserves empty labels", async () => {
    const result = await columnsFor({ steps: [{ fields: [
      { id: "a", type: "text", label: "" },
      { id: "b", type: "text", label: "Family" },
      { id: "c", type: "text", label: "Organisation" },
    ] }] });
    expect(result.fixedColumns).toStrictEqual([
      defaults[0],
      { id: "firstName", label: "", type: "text" },
      { id: "lastName", label: "Family", type: "text" },
      ...defaults.slice(3),
    ]);
    expect(result.formColumns).toStrictEqual([
      { id: "c", label: "Organisation", type: "text", options: undefined },
    ]);
  });

  it.each(["other", "AUTRE", "other_diet"])("folds the first matching child for %s across steps", async (trigger) => {
    const result = await columnsFor({ steps: [
      { fields: [{
        id: "diet", type: "dropdown", label: "Diet",
        options: [{ id: trigger, label: "Other", ignored: true }],
      }] },
      { fields: [
        { id: "detail", type: "text", conditions: [
          { fieldId: "diet", operator: "equals", value: trigger },
        ] },
        { id: "detail2", type: "text", conditions: [
          { fieldId: "diet", operator: "equals", value: trigger },
        ] },
      ] },
    ] });
    expect(result.formColumns).toStrictEqual([
      {
        id: "diet", label: "Diet", type: "dropdown",
        options: [{ id: trigger, label: "Other" }],
        mergeWith: { fieldId: "detail", triggerValue: trigger },
      },
      { id: "detail2", label: "detail2", type: "text", options: undefined },
    ]);
  });

  it("retains the existing first-equals-condition trigger quirk", async () => {
    const result = await columnsFor({ steps: [{ fields: [
      { id: "choice", type: "radio", options: [{ id: "other", label: "Other" }] },
      { id: "detail", type: "number", conditions: [
        { fieldId: "choice", operator: "equals", value: "unrelated" },
        { fieldId: "choice", operator: "equals", value: "other" },
      ] },
    ] }] });
    expect(result.formColumns).toStrictEqual([{
      id: "choice", label: "choice", type: "radio",
      options: [{ id: "other", label: "Other" }],
      mergeWith: { fieldId: "detail", triggerValue: "unrelated" },
    }]);
  });

  it("does not fold checkbox children or children without an other option", async () => {
    const result = await columnsFor({ steps: [{ fields: [
      { id: "many", type: "checkbox", options: [{ id: "other", label: "Other" }] },
      { id: "one", type: "radio", options: [{ id: "yes", label: "Yes" }] },
      { id: "detail", type: "number", conditions: [
        { fieldId: "many", operator: "equals", value: "other" },
        { fieldId: "one", operator: "equals", value: "other" },
      ] },
    ] }] });
    expect(result.formColumns.map(column => column.id)).toEqual(["many", "one", "detail"]);
    for (const column of result.formColumns) expect(column).not.toHaveProperty("mergeWith");
  });

  it.each([{}, { steps: null }, { steps: [{}] }])("preserves rejection of malformed schema %j", async (schema) => {
    const query = {
      select: vi.fn().mockReturnThis(), from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ schema }]),
    };
    for (const read of [getGridColumns, getReportColumns]) {
      await expect(read("event-1", query as unknown as DbExecutor)).rejects.toBeInstanceOf(TypeError);
    }
  });
});
