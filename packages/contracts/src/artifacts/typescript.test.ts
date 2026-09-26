import { describe, expect, it } from "vitest";
import type { JsonSchema, JsonSchemaDocument } from "./json-schema";
import { renderTypeScript, typeNameFor } from "./typescript";

function doc(defs: Record<string, JsonSchema>): JsonSchemaDocument {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $comment: "test", $defs: defs };
}

function typeOf(schema: JsonSchema, extra: Record<string, JsonSchema> = {}): string {
  const out = renderTypeScript(doc({ ...extra, TargetSchema: schema }), []);
  const match = /export type Target = ([\s\S]*?);\n(?:\n|$)/.exec(out);
  if (!match) throw new Error(`no Target type in:\n${out}`);
  return match[1];
}

describe("typeNameFor", () => {
  it("drops the Schema suffix", () => {
    expect(typeNameFor("CreateRegistrationBodySchema")).toBe("CreateRegistrationBody");
    expect(typeNameFor("FormSchemaJsonSchema")).toBe("FormSchemaJson");
    expect(typeNameFor("Plain")).toBe("Plain");
  });
});

describe("renderTypeScript", () => {
  it("renders objects with required and optional properties, quoting odd keys", () => {
    expect(
      typeOf({
        type: "object",
        properties: { id: { type: "string" }, "x-y": { type: "integer" }, flag: { type: "boolean", default: false } },
        required: ["id"],
        additionalProperties: false,
      }),
    ).toBe('{\n  id: string;\n  "x-y"?: number;\n  /** @default false */\n  flag?: boolean;\n}');
  });

  it("renders empty objects: closed has no keys, open has any", () => {
    expect(typeOf({ type: "object", properties: {}, additionalProperties: false })).toBe("Record<string, never>");
    expect(typeOf({ type: "object" })).toBe("Record<string, unknown>");
  });

  it("adds an index signature for a catchall next to declared properties", () => {
    expect(typeOf({ type: "object", properties: { a: { type: "string" } }, additionalProperties: {} })).toBe(
      "{\n  a?: string;\n  [key: string]: unknown;\n}",
    );
  });

  it("renders records", () => {
    expect(typeOf({ type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "number" } })).toBe(
      "Record<string, number>",
    );
    expect(
      typeOf({ type: "object", propertyNames: { type: "string", enum: ["a", "b"] }, additionalProperties: { type: "string" } }),
    ).toBe('{ [K in "a" | "b"]?: string }');
    expect(
      typeOf({
        type: "object",
        propertyNames: { type: "string", enum: ["a", "b"] },
        additionalProperties: { type: "string" },
        required: ["a", "b"],
      }),
    ).toBe('{ [K in "a" | "b"]: string }');
  });

  it("renders enums, consts, nullable unions and refs", () => {
    expect(typeOf({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(typeOf({ type: "string", const: "doc" })).toBe('"doc"');
    expect(typeOf({ anyOf: [{ $ref: "#/$defs/OtherSchema" }, { type: "null" }] }, { OtherSchema: { type: "string" } })).toBe(
      "Other | null",
    );
    expect(typeOf({ type: ["string", "null"] })).toBe("string | null");
  });

  it("collapses a union with an unknown member and ignores validation-only allOf members", () => {
    expect(typeOf({ anyOf: [{ type: "string" }, {}] })).toBe("unknown");
    expect(typeOf({ type: "string", minLength: 12, allOf: [{ pattern: "[A-Z]" }, { pattern: "[0-9]" }] })).toBe("string");
  });

  it("groups unions inside intersections and arrays without re-parsing literals", () => {
    expect(typeOf({ allOf: [{ anyOf: [{ const: "a" }, { const: "b" }] }, { type: "string" }] })).toBe('("a" | "b") & string');
    expect(typeOf({ type: "array", items: { enum: ["a | b", "(c)"] } })).toBe('Array<"a | b" | "(c)">');
    expect(typeOf({ type: "array", items: { $ref: "#/$defs/OtherSchema" } }, { OtherSchema: { type: "string" } })).toBe(
      "Other[]",
    );
    expect(typeOf({ type: "array", items: {} })).toBe("unknown[]");
  });

  it("renders tuples", () => {
    expect(typeOf({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] })).toBe("[string, number]");
    expect(typeOf({ type: "array", prefixItems: [{ type: "string" }], items: { type: "boolean" } })).toBe(
      "[string, ...boolean[]]",
    );
  });

  it("supports recursive refs", () => {
    const out = renderTypeScript(
      doc({
        NodeSchema: {
          type: "object",
          properties: { children: { type: "array", items: { $ref: "#/$defs/NodeSchema" } } },
          additionalProperties: false,
        },
      }),
      ["header"],
    );
    expect(out).toBe("// header\n\nexport type Node = {\n  children?: Node[];\n};\n");
  });

  it("puts $comment markers, including those on union members, in the doc comment", () => {
    const out = renderTypeScript(
      doc({
        SlotSchema: {
          type: "object",
          properties: { at: { anyOf: [{ type: "string", format: "date-time", $comment: "a date" }, { type: "null" }] } },
          required: ["at"],
        },
      }),
      [],
    );
    expect(out).toContain("  /** a date */\n  at: string | null;");
  });

  it("refuses constructs it does not know instead of guessing", () => {
    expect(() => typeOf({ if: { type: "string" } })).toThrow(/Unsupported JSON Schema keyword "if"/);
    expect(() => typeOf({ type: "bigint" })).toThrow(/Unsupported JSON Schema type/);
    expect(() => typeOf({ $ref: "#/$defs/Missing" })).toThrow(/Unresolvable \$ref/);
    expect(() =>
      typeOf({ type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "number" } }),
    ).toThrow(/Typed additionalProperties/);
    expect(() => typeOf({ type: "object", properties: {}, required: ["ghost"] })).toThrow(/ghost is not declared/);
  });

  it("refuses two schemas that map to one type name", () => {
    expect(() => renderTypeScript(doc({ FooSchema: { type: "string" }, Foo: { type: "number" } }), [])).toThrow(
      /Two schemas map to the type name Foo/,
    );
  });
});
