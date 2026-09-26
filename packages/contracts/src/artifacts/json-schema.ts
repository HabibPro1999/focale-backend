/**
 * JSON Schema (draft 2020-12) for every Zod schema the API contract modules
 * export, one document per direction:
 * - `input`: what a client sends, before the server parses it (defaults
 *   optional, objects open because unknown keys are stripped).
 * - `output`: what the schema produces after parsing (defaults filled,
 *   objects closed). Response bodies built from these schemas have this shape
 *   once serialized to JSON.
 *
 * Every exported schema is a `$defs` entry named after its export, and a
 * schema used inside another one is a `$ref` to its entry. Zod features JSON
 * Schema cannot express never fail generation silently: they carry a
 * `$comment` at the exact spot and are listed in the manifest
 * (`findUnrepresentable`), and any other one throws so it gets a decision.
 */
import { z } from "zod";
import * as abstracts from "../abstracts";
import * as abstractsResponses from "../abstracts.responses";
import * as access from "../access";
import * as certificates from "../certificates";
import * as checkin from "../checkin";
import * as clients from "../clients";
import * as conditionSchema from "../condition.schema";
import * as email from "../email";
import * as events from "../events";
import * as eventsResponses from "../events.responses";
import * as forms from "../forms";
import * as formsResponses from "../forms.responses";
import * as health from "../health";
import * as i18n from "../i18n.schema";
import * as identity from "../identity";
import * as networking from "../networking";
import * as networkingAdminResponses from "../networking.admin.responses";
import * as networkingPublicResponses from "../networking.public.responses";
import * as networkingAuthResponses from "../networking.auth-recommendations.responses";
import * as pricing from "../pricing";
import * as realtime from "../realtime";
import * as registrations from "../registrations";
import * as registrationsResponses from "../registrations.responses";
import * as reports from "../reports";
import * as sponsorships from "../sponsorships";
import * as sponsorshipsResponses from "../sponsorships.responses";

/**
 * The API contract modules, by file name. Server-only modules (env config,
 * DB settings, keys, error catalog) are deliberately absent; a test fails when
 * the barrel exports a Zod schema from a module that is not listed here.
 */
export const CONTRACT_MODULES: Readonly<Record<string, Record<string, unknown>>> = {
  abstracts,
  "abstracts.responses": abstractsResponses,
  access,
  certificates,
  checkin,
  clients,
  "condition.schema": conditionSchema,
  email,
  events,
  "events.responses": eventsResponses,
  forms,
  "forms.responses": formsResponses,
  health,
  "i18n.schema": i18n,
  identity,
  networking,
  "networking.admin.responses": networkingAdminResponses,
  "networking.public.responses": networkingPublicResponses,
  "networking.auth-recommendations.responses": networkingAuthResponses,
  pricing,
  realtime,
  registrations,
  "registrations.responses": registrationsResponses,
  reports,
  sponsorships,
  "sponsorships.responses": sponsorshipsResponses,
};

export type SchemaDirection = "input" | "output";

export interface ContractSchemaEntry {
  /** Export name, e.g. `CreateRegistrationBodySchema`; the `$defs` key. */
  name: string;
  /** Contract module file (without `.ts`). */
  module: string;
  schema: z.ZodType;
  /** Set when the same schema object is also exported under an earlier name. */
  aliasOf?: string;
}

/** Every exported contract schema, sorted by module then export name. */
export function collectContractSchemas(): ContractSchemaEntry[] {
  const entries: ContractSchemaEntry[] = [];
  const firstName = new Map<z.ZodType, string>();
  for (const module of Object.keys(CONTRACT_MODULES).sort()) {
    const moduleExports = CONTRACT_MODULES[module];
    for (const name of Object.keys(moduleExports).sort()) {
      const value = moduleExports[name];
      if (!(value instanceof z.ZodType)) continue;
      const aliasOf = firstName.get(value);
      if (aliasOf === undefined) firstName.set(value, name);
      entries.push({ name, module, schema: value, ...(aliasOf ? { aliasOf } : {}) });
    }
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`Contract schema name ${entry.name} is exported by two modules`);
    seen.add(entry.name);
  }
  return entries;
}

export type JsonSchema = { [keyword: string]: unknown };

export interface JsonSchemaDocument {
  $schema: string;
  $comment: string;
  $defs: Record<string, JsonSchema>;
}

export type UnrepresentableReason = "date" | "transform" | "preprocess" | "opaque";

export interface UnrepresentableEntry {
  direction: SchemaDirection;
  /** JSON pointer into the direction's document. */
  pointer: string;
  reason: UnrepresentableReason;
}

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** `$comment` markers; `findUnrepresentable` reads them back. */
export const UNREPRESENTABLE_COMMENTS: Readonly<Record<UnrepresentableReason, string>> = {
  date: "unrepresentable: date. A Date on the server; on the wire an ISO 8601 string (input: any string the server's Date parser accepts).",
  transform: "unrepresentable: transform. The server computes this value in code; JSON Schema cannot describe the result.",
  preprocess: "unrepresentable: preprocess. The server converts the raw value in code first (e.g. a query string); this describes the converted value.",
  opaque: "unrepresentable: opaque. The schema accepts any JSON and validates it in server code (z.unknown().transform); see the contract module.",
};

// Zod types toJSONSchema cannot express. `date` and `transform` are handled
// (mapped / marked); the others throw so a new one gets an explicit decision.
const UNHANDLED_TYPES = new Set([
  "bigint",
  "symbol",
  "undefined",
  "void",
  "map",
  "set",
  "nan",
  "promise",
  "function",
  "custom",
]);

function isTransform(def: unknown): boolean {
  const input = (def as { in?: { _zod?: { def?: { type?: string } } } }).in;
  return input?._zod?.def?.type === "transform";
}

/** `z.unknown().transform(...)`: the whole shape lives in code. */
function isPipeIntoTransform(schema: z.ZodType): boolean {
  const def = schema._zod.def as { type: string; out?: { _zod?: { def?: { type?: string } } } };
  return def.type === "pipe" && def.out?._zod?.def?.type === "transform";
}

function refFor(name: string): string {
  return `#/$defs/${name}`;
}

/** Render the `$defs` document for one direction. */
export function renderJsonSchemaDocument(
  direction: SchemaDirection,
  entries: readonly ContractSchemaEntry[] = collectContractSchemas(),
): JsonSchemaDocument {
  const registry = z.registry<{ id: string }>();
  for (const entry of entries) {
    if (!entry.aliasOf) registry.add(entry.schema, { id: entry.name });
  }

  const generated = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    io: direction,
    unrepresentable: "any",
    cycles: "ref",
    reused: "inline",
    uri: refFor,
    override(ctx) {
      const type = ctx.zodSchema._zod.def.type;
      if (type === "date") {
        ctx.jsonSchema.type = "string";
        ctx.jsonSchema.format = "date-time";
        ctx.jsonSchema.$comment = UNREPRESENTABLE_COMMENTS.date;
      } else if (type === "transform") {
        ctx.jsonSchema.$comment = UNREPRESENTABLE_COMMENTS.transform;
      } else if (type === "pipe" && direction === "input" && isTransform(ctx.zodSchema._zod.def)) {
        // z.preprocess: toJSONSchema describes the target schema instead.
        ctx.jsonSchema.$comment = UNREPRESENTABLE_COMMENTS.preprocess;
      } else if (UNHANDLED_TYPES.has(type)) {
        throw new Error(`Contract schemas use z.${type}(), which JSON Schema cannot express; decide how to export it`);
      }
    },
  });

  const defs: Record<string, JsonSchema> = {};
  for (const entry of entries) {
    if (entry.aliasOf) {
      defs[entry.name] = { $ref: refFor(entry.aliasOf) };
      continue;
    }
    const raw = generated.schemas[entry.name] as JsonSchema | undefined;
    if (!raw) throw new Error(`toJSONSchema produced no schema for ${entry.name}`);
    const rest: JsonSchema = { ...raw };
    delete rest.$schema;
    delete rest.$id;
    if ("$defs" in rest) {
      throw new Error(`${entry.name} has nested $defs; register the shared or recursive schema it uses`);
    }
    if (Object.keys(rest).length === 0 && isPipeIntoTransform(entry.schema)) {
      rest.$comment = UNREPRESENTABLE_COMMENTS.opaque;
    }
    defs[entry.name] = rest;
  }

  const sortedDefs: Record<string, JsonSchema> = {};
  for (const name of Object.keys(defs).sort()) sortedDefs[name] = canonicalize(defs[name]) as JsonSchema;

  return {
    $schema: DRAFT_2020_12,
    $comment: `GENERATED by \`pnpm contracts:generate\` from packages/contracts (${direction} side). Do not edit.`,
    $defs: sortedDefs,
  };
}

/**
 * Stable key order: keywords sorted; property names keep their declaration
 * order (meaningful to readers, and fixed by the source).
 */
function canonicalize(value: unknown, keepKeyOrder = false): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const keys = keepKeyOrder ? Object.keys(source) : Object.keys(source).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = canonicalize(source[key], !keepKeyOrder && key === "properties");
  }
  return out;
}

/** Every `$comment` marker in a document, as sorted JSON pointers. */
export function findUnrepresentable(
  direction: SchemaDirection,
  document: JsonSchemaDocument,
): UnrepresentableEntry[] {
  const reasons = new Map<string, UnrepresentableReason>(
    Object.entries(UNREPRESENTABLE_COMMENTS).map(([reason, comment]) => [comment, reason as UnrepresentableReason]),
  );
  const found: UnrepresentableEntry[] = [];
  const walk = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${pointer}/${index}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "$comment" && typeof child === "string" && reasons.has(child)) {
        found.push({ direction, pointer, reason: reasons.get(child)! });
      } else {
        walk(child, `${pointer}/${escapePointer(key)}`);
      }
    }
  };
  walk(document.$defs, "/$defs");
  return found.sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0));
}

function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}
