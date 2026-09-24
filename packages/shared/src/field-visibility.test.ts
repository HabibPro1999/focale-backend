import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateConditions,
  filterVisibleFormData,
  getVisibleFieldIds,
  type FieldCondition,
} from "./field-visibility";

interface ParityCase {
  name: string;
  conditions: unknown[];
  logic?: string;
  formData: Record<string, unknown>;
  expected: boolean | "throws";
}

// Shared with the form app: the same file is the contract for its evaluator
// (form/src/lib/conditions.ts). The form repo has no tests of its own for it.
const parity = JSON.parse(
  readFileSync(join(__dirname, "field-visibility.parity-cases.json"), "utf8"),
) as { cases: ParityCase[] };

function evaluate(c: ParityCase): boolean {
  return evaluateConditions(
    c.conditions as FieldCondition[],
    c.logic as "and" | "or" | undefined,
    c.formData,
  );
}

describe("field visibility — parity with the form app", () => {
  afterEach(() => vi.restoreAllMocks());

  it("has cases for every quirk", () => {
    expect(parity.cases.length).toBeGreaterThanOrEqual(50);
  });

  it.each(parity.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (c.expected === "throws") {
      expect(() => evaluate(c)).toThrow(TypeError);
    } else {
      expect(evaluate(c)).toBe(c.expected);
    }
  });

  it("treats undefined conditions as visible", () => {
    expect(evaluateConditions(undefined, "and", {})).toBe(true);
  });
});

describe("getVisibleFieldIds / filterVisibleFormData", () => {
  it("keeps only the answers of visible fields", () => {
    const fields = [
      { id: "specialty" },
      {
        id: "otherSpecialty",
        conditions: [
          { id: "c1", fieldId: "specialty", operator: "equals" as const, value: "other" },
        ],
      },
      {
        id: "residentYear",
        conditions: [
          { id: "c2", fieldId: "specialty", operator: "equals" as const, value: "resident" },
        ],
      },
    ];
    const data = { specialty: "Other", otherSpecialty: "Nephrology", residentYear: "3" };

    const visible = getVisibleFieldIds(fields, data);

    expect([...visible]).toEqual(["specialty", "otherSpecialty"]);
    expect(filterVisibleFormData(data, visible)).toEqual({
      specialty: "Other",
      otherSpecialty: "Nephrology",
    });
  });
});
