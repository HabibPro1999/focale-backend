import { describe, expect, it } from "vitest";
import {
  formatFormConditionReport,
  scanFormConditions,
  type FormRowForConditionReport,
} from "./form-condition-scan";

const form = (schema: unknown, overrides: Partial<FormRowForConditionReport> = {}) => ({
  id: "form1",
  name: "Registration",
  eventId: "ev1",
  type: "REGISTRATION",
  active: true,
  schema,
  ...overrides,
});
const cond = (fieldId: string, operator: string, value?: unknown) => ({ id: "c", fieldId, operator, value });

describe("scanFormConditions", () => {
  it("flags uppercase logic and whether lowercasing changes visibility", () => {
    const findings = scanFormConditions(
      form({
        steps: [
          {
            id: "s1",
            fields: [
              { id: "a" },
              { id: "b" },
              { id: "both", conditionLogic: "AND", conditions: [cond("a", "equals", "1"), cond("b", "equals", "2")] },
              { id: "single", conditionLogic: "AND", conditions: [cond("a", "equals", "1")] },
              { id: "either", conditionLogic: "OR", conditions: [cond("a", "equals", "1"), cond("b", "equals", "2")] },
              { id: "fine", conditionLogic: "and", conditions: [cond("a", "equals", "1"), cond("b", "equals", "2")] },
              { id: "default", conditions: [cond("a", "equals", "1"), cond("b", "equals", "2")] },
            ],
          },
        ],
      }),
    );
    expect(findings.map((f) => [f.kind, f.fieldId, f.changesVisibility])).toEqual([
      ["UPPERCASE_LOGIC", "both", true],
      ["UPPERCASE_LOGIC", "single", false],
      ["UPPERCASE_LOGIC", "either", false],
    ]);
  });

  it("flags non-string text comparisons, unknown operators and missing fields", () => {
    const findings = scanFormConditions(
      form({
        steps: [
          {
            id: "s1",
            fields: [
              { id: "age", type: "number" },
              {
                id: "note",
                conditions: [
                  cond("age", "equals", 42),
                  cond("age", "contains"),
                  cond("age", "greater_than", 18),
                  cond("age", "is_empty"),
                  cond("age", "in", "x"),
                  cond("deleted", "equals", "yes"),
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(findings.map((f) => f.kind)).toEqual([
      "NON_STRING_VALUE",
      "NON_STRING_VALUE",
      "UNKNOWN_OPERATOR",
      "UNKNOWN_FIELD",
    ]);
  });

  it("scans sponsor forms and tolerates malformed schemas", () => {
    const sponsor = form(
      {
        sponsorSteps: [{ id: "s", fields: [{ id: "company" }] }],
        beneficiaryTemplate: {
          fields: [{ id: "role", conditionLogic: "AND", conditions: [cond("company", "equals", "x"), cond("company", "is_empty")] }],
        },
      },
      { type: "SPONSOR" },
    );
    expect(scanFormConditions(sponsor).map((f) => [f.kind, f.fieldId])).toEqual([["UPPERCASE_LOGIC", "role"]]);
    expect(scanFormConditions(form(null))).toEqual([]);
    expect(scanFormConditions(form({ steps: [{ id: "s" }, null] }))).toEqual([]);
  });
});

describe("formatFormConditionReport", () => {
  it("prints one line per finding and a per-form summary", () => {
    const findings = scanFormConditions(
      form(
        {
          steps: [
            {
              id: "s1",
              fields: [
                { id: "a" },
                { id: "b", conditionLogic: "AND", conditions: [cond("a", "equals", "1"), cond("a", "equals", 2)] },
              ],
            },
          ],
        },
        { active: false },
      ),
    );
    const lines = formatFormConditionReport({ scanned: 3, findings });
    expect(lines[0]).toBe(
      '[UPPERCASE_LOGIC] form form1 "Registration" (event ev1, REGISTRATION, inactive) field "b": conditionLogic "AND" with 2 conditions is evaluated as OR; lowercasing to "and" changes who sees this field',
    );
    expect(lines[1]).toMatch(/^\[NON_STRING_VALUE\] .* field "b": "equals" on field "a" has number 2;/);
    expect(lines.at(-1)).toBe(
      "Scanned 3 form(s): 1 with uppercase conditionLogic (1 where lowercasing changes visibility), 1 with non-string condition values, 0 with unknown operators, 0 with conditions on missing fields. Nothing was changed.",
    );
  });
});
