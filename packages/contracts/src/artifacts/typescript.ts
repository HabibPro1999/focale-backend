/**
 * TypeScript types from the generated JSON Schema documents, so the types and
 * the schemas can never disagree (a Date is a `string`, as on the wire).
 *
 * Handles exactly the JSON Schema subset `z.toJSONSchema` emits for the
 * contracts and throws on anything else, so a new construct fails generation
 * instead of degrading to a wrong type.
 */
import type { JsonSchema, JsonSchemaDocument } from "./json-schema";

/** Keywords that only constrain values; they don't change the TS type. */
const VALIDATION_ONLY = new Set([
  "$comment",
  "default",
  "description",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "multipleOf",
  "pattern",
  "title",
  "uniqueItems",
]);

const STRUCTURAL = new Set([
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "enum",
  "items",
  "oneOf",
  "prefixItems",
  "properties",
  "propertyNames",
  "required",
  "type",
]);

const PRIMITIVES: Record<string, string> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
  null: "null",
};

/** `CreateRegistrationBodySchema` → `CreateRegistrationBody`. */
export function typeNameFor(defName: string): string {
  return defName.endsWith("Schema") && defName !== "Schema" ? defName.slice(0, -"Schema".length) : defName;
}

export function renderTypeScript(document: JsonSchemaDocument, header: readonly string[]): string {
  const names = new Map<string, string>();
  for (const defName of Object.keys(document.$defs)) {
    const typeName = typeNameFor(defName);
    if ([...names.values()].includes(typeName)) throw new Error(`Two schemas map to the type name ${typeName}`);
    names.set(defName, typeName);
  }
  const emitter = new Emitter(names);
  const out = header.map((line) => (line ? `// ${line}` : "//"));
  for (const [defName, schema] of Object.entries(document.$defs)) {
    out.push("");
    out.push(...docComment(schema, ""));
    out.push(`export type ${names.get(defName)} = ${emitter.type(schema, "")};`);
  }
  return `${out.join("\n")}\n`;
}

function docComment(schema: JsonSchema, indent: string): string[] {
  const lines: string[] = [];
  if (typeof schema.description === "string") lines.push(...schema.description.split("\n"));
  // Comments on union members (e.g. the Date in `Date | null`) belong to the property too.
  const members = [schema, ...(["anyOf", "oneOf"] as const).flatMap((key) => (Array.isArray(schema[key]) ? schema[key] : []))];
  for (const member of members as JsonSchema[]) {
    if (typeof member.$comment === "string" && !lines.includes(member.$comment)) lines.push(member.$comment);
  }
  if ("default" in schema) lines.push(`@default ${JSON.stringify(schema.default)}`);
  if (lines.length === 0) return [];
  if (lines.length === 1) return [`${indent}/** ${escapeComment(lines[0])} */`];
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${escapeComment(line)}`), `${indent} */`];
}

function escapeComment(text: string): string {
  return text.replace(/\*\//g, "*\\/");
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  throw new Error(`Unsupported literal in JSON Schema: ${JSON.stringify(value)}`);
}

/** A rendered type plus its top-level operator, so grouping never re-parses text. */
interface Rendered {
  text: string;
  op: "none" | "union" | "intersection";
}

const UNKNOWN: Rendered = { text: "unknown", op: "none" };

function atom(text: string): Rendered {
  return { text, op: "none" };
}

function unionOf(members: Rendered[]): Rendered {
  if (members.some((member) => member.text === "unknown")) return UNKNOWN;
  const unique = new Map<string, Rendered>();
  for (const member of members) unique.set(member.text, member);
  const list = [...unique.values()];
  if (list.length === 0) return atom("never");
  if (list.length === 1) return list[0];
  return {
    text: list.map((member) => (member.op === "intersection" ? `(${member.text})` : member.text)).join(" | "),
    op: "union",
  };
}

function intersectionOf(members: Rendered[]): Rendered {
  const typed = members.filter((member) => member.text !== "unknown");
  if (typed.length === 0) return UNKNOWN;
  if (typed.length === 1) return typed[0];
  return {
    text: typed.map((member) => (member.op === "union" ? `(${member.text})` : member.text)).join(" & "),
    op: "intersection",
  };
}

function arrayOf(item: Rendered): string {
  return item.op === "none" && /^[A-Za-z0-9_$."-]+$/.test(item.text) ? `${item.text}[]` : `Array<${item.text}>`;
}

class Emitter {
  constructor(private readonly names: ReadonlyMap<string, string>) {}

  type(schema: JsonSchema, indent: string): string {
    return this.render(schema, indent).text;
  }

  private render(schema: JsonSchema, indent: string): Rendered {
    for (const keyword of Object.keys(schema)) {
      if (!VALIDATION_ONLY.has(keyword) && !STRUCTURAL.has(keyword)) {
        throw new Error(`Unsupported JSON Schema keyword "${keyword}"`);
      }
    }

    const parts: Rendered[] = [];
    if (typeof schema.$ref === "string") parts.push(atom(this.ref(schema.$ref)));
    if ("const" in schema) parts.push(atom(literal(schema.const)));
    else if (Array.isArray(schema.enum)) parts.push(unionOf(schema.enum.map((value) => atom(literal(value)))));
    else if (schema.type !== undefined) parts.push(this.typed(schema, indent));
    else if (hasObjectKeywords(schema)) parts.push(atom(this.object(schema, indent)));

    for (const keyword of ["anyOf", "oneOf"] as const) {
      const members = schema[keyword];
      if (members === undefined) continue;
      if (!Array.isArray(members)) throw new Error(`${keyword} must be an array`);
      parts.push(unionOf(members.map((member) => this.render(member as JsonSchema, indent))));
    }
    if (schema.allOf !== undefined) {
      if (!Array.isArray(schema.allOf)) throw new Error("allOf must be an array");
      for (const member of schema.allOf) parts.push(this.render(member as JsonSchema, indent));
    }
    return intersectionOf(parts);
  }

  private ref(ref: string): string {
    const match = /^#\/\$defs\/(.+)$/.exec(ref);
    const name = match ? this.names.get(match[1]) : undefined;
    if (!name) throw new Error(`Unresolvable $ref ${ref}`);
    return name;
  }

  private typed(schema: JsonSchema, indent: string): Rendered {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    return unionOf(
      types.map((type) => {
        if (typeof type !== "string") throw new Error(`Invalid type ${JSON.stringify(type)}`);
        if (type === "object") return atom(this.object(schema, indent));
        if (type === "array") return atom(this.array(schema, indent));
        const primitive = PRIMITIVES[type];
        if (!primitive) throw new Error(`Unsupported JSON Schema type "${type}"`);
        return atom(primitive);
      }),
    );
  }

  private array(schema: JsonSchema, indent: string): string {
    const prefix = schema.prefixItems;
    const items = schema.items;
    if (prefix !== undefined) {
      if (!Array.isArray(prefix)) throw new Error("prefixItems must be an array");
      const members = prefix.map((member) => this.type(member as JsonSchema, indent));
      if (items !== undefined && items !== false) {
        members.push(`...${arrayOf(this.render(items as JsonSchema, indent))}`);
      }
      return `[${members.join(", ")}]`;
    }
    if (items === undefined) return "unknown[]";
    if (typeof items !== "object" || items === null || Array.isArray(items)) {
      throw new Error("items must be a schema");
    }
    return arrayOf(this.render(items as JsonSchema, indent));
  }

  private object(schema: JsonSchema, indent: string): string {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((schema.required ?? []) as string[]);
    const additional = schema.additionalProperties;
    const inner = `${indent}  `;

    if (schema.propertyNames !== undefined) {
      if (Object.keys(properties).length > 0) throw new Error("propertyNames together with properties is not supported");
      const keys = schema.propertyNames as JsonSchema;
      const value = additional === undefined || additional === true ? "unknown" : this.type(additional as JsonSchema, inner);
      if (Array.isArray(keys.enum)) {
        const keyUnion = unionOf(keys.enum.map((key) => atom(literal(key)))).text;
        const all = keys.enum.every((key) => required.has(String(key)));
        if (!all && required.size > 0) throw new Error("Partially required enum records are not supported");
        return `{ [K in ${keyUnion}]${all ? "" : "?"}: ${value} }`;
      }
      return `Record<${this.type(keys, inner)}, ${value}>`;
    }

    const lines: string[] = [];
    for (const [name, property] of Object.entries(properties)) {
      lines.push(...docComment(property, inner));
      const optional = required.has(name) ? "" : "?";
      lines.push(`${inner}${propertyKey(name)}${optional}: ${this.type(property, inner)};`);
    }
    for (const name of required) {
      if (!(name in properties)) throw new Error(`required property ${name} is not declared`);
    }

    if (additional !== undefined && additional !== false) {
      const value = additional === true ? "unknown" : this.type(additional as JsonSchema, inner);
      if (lines.length === 0) return `Record<string, ${value}>`;
      if (value !== "unknown") throw new Error("Typed additionalProperties next to declared properties is not supported");
      lines.push(`${inner}[key: string]: unknown;`);
    }

    if (lines.length === 0) {
      // No declared properties: closed means no keys at all; open means any object.
      return additional === false ? "Record<string, never>" : "Record<string, unknown>";
    }
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
}

function hasObjectKeywords(schema: JsonSchema): boolean {
  return "properties" in schema || "additionalProperties" in schema || "propertyNames" in schema;
}
