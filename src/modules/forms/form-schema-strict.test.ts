import { describe, it, expect } from "vitest";
import { FormSchemaJsonSchema } from "./forms.schema.js";

describe("FormSchemaJsonSchema — strictObject", () => {
  it("should accept a valid schema with steps", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          fields: [{ id: "f1", type: "text", label: "Name" }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("should accept an empty steps array", () => {
    const result = FormSchemaJsonSchema.safeParse({ steps: [] });
    expect(result.success).toBe(true);
  });

  it("should accept a schema with no steps key", () => {
    const result = FormSchemaJsonSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should reject extra top-level keys", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [],
      extraKey: "this should not be here",
    });
    expect(result.success).toBe(false);
  });

  it("should reject multiple extra top-level keys", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [],
      foo: 1,
      bar: "baz",
    });
    expect(result.success).toBe(false);
  });

  it("should reject a step with extra keys (nested strictObject)", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          fields: [],
          unknownStepKey: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("should reject a field with an unknown type", () => {
    const result = FormSchemaJsonSchema.safeParse({
      steps: [
        {
          id: "step-1",
          title: "Info",
          fields: [{ id: "f1", type: "invalidType", label: "Name" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
