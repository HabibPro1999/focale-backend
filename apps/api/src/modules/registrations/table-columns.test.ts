import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureJsonbValidation,
  getRegistrationTableColumns as getReportColumns,
  StoredJsonError,
  type DbExecutor,
} from "@app/db";
import { getRegistrationTableColumns as getGridColumns } from "./table-columns";

function executor(schema: unknown, absent = false): DbExecutor {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(absent ? [] : [{ id: "form-1", schema }]),
  } as unknown as DbExecutor;
}

afterEach(() => configureJsonbValidation(undefined));

describe("registration grid/export column characterization", () => {
  it.each(["warn", "enforce"] as const)("agrees on valid forms in %s mode", async (mode) => {
    configureJsonbValidation(mode);
    const schema = { steps: [
      { id: "contact", title: "Contact", fields: [
        { id: "email", type: "email", label: "Courriel" },
        { id: "first", type: "text", label: "Prénom" },
        { id: "last", type: "text", label: "Nom" },
        { id: "phone", type: "phone", label: "Téléphone" },
        { id: "heading", type: "heading" },
        { id: "diet", type: "dropdown", options: [{ id: "AUTRE", label: "Autre" }] },
      ] },
      { id: "details", title: "Details", fields: [
        { id: "detail", type: "text", conditions: [{ fieldId: "diet", operator: "equals", value: "AUTRE" }] },
        { id: "laterEmail", type: "email", label: "Other email" },
      ] },
    ] };
    const grid = await getGridColumns("event-1", executor(schema));
    expect(await getReportColumns("event-1", executor(schema))).toStrictEqual(grid);
    expect(grid.fixedColumns.slice(0, 4).map(column => column.label)).toEqual([
      "Courriel", "Prénom", "Nom", "Téléphone",
    ]);
    expect(grid.formColumns).toStrictEqual([
      { id: "diet", label: "diet", type: "dropdown", options: [{ id: "AUTRE", label: "Autre" }], mergeWith: { fieldId: "detail", triggerValue: "AUTRE" } },
      { id: "laterEmail", label: "Other email", type: "email", options: undefined },
    ]);
  });

  it.each(["warn", "enforce"] as const)("agrees when no form exists in %s mode", async (mode) => {
    configureJsonbValidation(mode);
    const grid = await getGridColumns("event-1", executor(undefined, true));
    expect(await getReportColumns("event-1", executor(undefined, true))).toStrictEqual(grid);
    expect(grid.formColumns).toEqual([]);
  });

  // The report skips the decoder for a falsy stored schema; the grid does not.
  // Preserve this existing divergence instead of consolidating the two paths.
  it.each([null, false])("keeps different enforce-mode behavior for stored %j", async (schema) => {
    configureJsonbValidation("enforce");
    await expect(getGridColumns("event-1", executor(schema))).rejects.toBeInstanceOf(StoredJsonError);
    const report = await getReportColumns("event-1", executor(schema));
    expect(report.formColumns).toEqual([]);
    expect(report.fixedColumns.map(column => column.id)).toEqual([
      "email", "firstName", "lastName", "phone", "paymentStatus", "totalAmount", "createdAt",
    ]);
  });
});
