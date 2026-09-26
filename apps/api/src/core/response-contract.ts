import { SetMetadata } from "@nestjs/common";
import type { ZodType, input as ZodInput } from "zod";

/**
 * Per-route response contracts (plan 5.5).
 *
 * `@ResponseContract(schema)` declares the `data` payload a route returns. The
 * envelope interceptor projects the handler's result onto the schema before
 * wrapping it: object keys the schema does not declare are dropped, at every
 * depth, in every environment, so a column added to a table (or a field added
 * to a service result) is never public by default. Everything the schema
 * declares keeps its value and its original key order, so a response that
 * already matches its contract is serialized byte for byte as before.
 *
 * Outside production the interceptor also logs the dropped key paths (names
 * only, never values) and validates the projected payload, failing the
 * request with a 500 when it does not match, so drift shows up in dev and CI.
 *
 * Routes without a contract are returned unchanged.
 */
export const RESPONSE_CONTRACT = "responseContract";

type Awaitable<T> = T | Promise<T>;

type Leaf = string | number | boolean | bigint | symbol | null | undefined | Date;
type JoinPath<P extends string, K extends string> = P extends "" ? K : `${P}.${K}`;
type KeysOf<C> = C extends object ? keyof C : never;
type FieldOf<C, K extends PropertyKey> = C extends object
  ? K extends keyof C
    ? C[K]
    : never
  : never;
type ItemOf<C> = C extends readonly (infer I)[] ? I : never;

/**
 * Key paths of `T` (a handler's static result) that the contract type `C`
 * does not declare, i.e. what the projection would drop from a response of
 * that type; `never` when nothing would be dropped. Opaque contract fields
 * (`unknown`) accept anything below them.
 */
export type DroppedKeys<T, C, P extends string = ""> = 0 extends 1 & T
  ? never // any: nothing known statically
  : unknown extends C
    ? never
    : T extends Leaf
      ? never
      : T extends readonly (infer I)[]
        ? DroppedKeys<I, ItemOf<C>, `${P}[]`>
        : T extends object
          ? string extends keyof T
            ? // A record: its keys are data, only its values have a shape.
              string extends KeysOf<C>
              ? DroppedKeys<T[string & keyof T], FieldOf<C, string>, `${P}{}`>
              : `${P}{}`
            : {
                [K in keyof T & string]-?: K extends KeysOf<C>
                  ? DroppedKeys<T[K], FieldOf<C, K>, JoinPath<P, K>>
                  : JoinPath<P, K>;
              }[keyof T & string]
          : never;

/** `unknown` (no constraint) when nothing is dropped; otherwise names the dropped keys. */
type KeepsEveryKey<T, C> = [DroppedKeys<T, C>] extends [never]
  ? unknown
  : { "response keys this contract drops": DroppedKeys<T, C> };

/**
 * Attach a response contract to a route handler. Typed so that, at compile
 * time, the handler's return type must satisfy the schema's input type and
 * declare no key the contract would drop: a field added to a service result
 * fails typecheck here until it is listed in the contract (or removed from
 * the result on purpose). Data the static type does not show (casts, JSON
 * documents) is still projected at runtime. Throws at decoration time, so at
 * boot, when the schema uses a construct the projection cannot apply safely
 * (open objects, transforms, pipes, …).
 */
export function ResponseContract<S extends ZodType>(schema: S) {
  assertProjectable(schema);
  const setMetadata = SetMetadata(RESPONSE_CONTRACT, schema);
  return <H extends (...args: never[]) => Awaitable<ZodInput<S>>>(
    target: object,
    key: string | symbol,
    descriptor: TypedPropertyDescriptor<H> &
      KeepsEveryKey<Awaited<ReturnType<H>>, ZodInput<S>>,
  ): void => {
    setMetadata(target, key, descriptor);
  };
}

// ============================================================================
// Projection
// ============================================================================

export interface ContractProjection {
  /** The payload with every undeclared object key removed. */
  value: unknown;
  /**
   * Dropped key paths, deduplicated, in the order met: `a.b` for object keys,
   * `a[]` for array items, `a{}` for record values. A value of the wrong kind
   * where the schema expects a scalar (an object or array where a string is
   * declared, say) is dropped too and reported under its own path.
   */
  stripped: string[];
}

/** Project `value` onto `schema` (see the module comment). Never throws on data. */
export function projectOntoContract(
  schema: ZodType,
  value: unknown,
): ContractProjection {
  const stripped = new Set<string>();
  const projected = project(schema, value, "", stripped);
  return {
    value: projected === DROP ? undefined : projected,
    stripped: [...stripped],
  };
}

const DROP: unique symbol = Symbol("drop");

type Def = { type: string } & Record<string, unknown>;

function defOf(schema: ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Objects and arrays carry nested keys; scalars (and Dates) do not. */
function carriesKeys(value: unknown): boolean {
  return typeof value === "object" && value !== null && !(value instanceof Date);
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** Wrappers whose inner schema describes the non-null/undefined value. */
const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
]);

/** Scalars: returned as they are (the value itself carries no keys). */
const SCALARS = new Set([
  "string",
  "number",
  "int",
  "boolean",
  "bigint",
  "date",
  "enum",
  "literal",
  "null",
  "undefined",
  "nan",
  "never",
  "void",
  "template_literal",
]);

/** Opaque subtrees (JSON the server does not own the shape of, e.g. formData). */
const OPAQUE = new Set(["unknown", "any"]);

function project(
  schema: ZodType,
  value: unknown,
  path: string,
  stripped: Set<string>,
): unknown {
  const def = defOf(schema);

  if (WRAPPERS.has(def.type)) {
    if (value === null || value === undefined) return value;
    return project(def.innerType as ZodType, value, path, stripped);
  }
  if (OPAQUE.has(def.type)) return value;
  if (def.type === "lazy") {
    return project((def.getter as () => ZodType)(), value, path, stripped);
  }

  switch (def.type) {
    case "object": {
      if (!isPlainObject(value)) return dropKeyed(value, path, stripped);
      const shape = def.shape as Record<string, ZodType>;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const field = Object.hasOwn(shape, key) ? shape[key] : undefined;
        if (field === undefined) {
          stripped.add(join(path, key));
          continue;
        }
        const projected = project(field, item, join(path, key), stripped);
        if (projected !== DROP) out[key] = projected;
      }
      return out;
    }
    case "array": {
      if (!Array.isArray(value)) return dropKeyed(value, path, stripped);
      const element = def.element as ZodType;
      return value.map((item) => {
        const projected = project(element, item, `${path}[]`, stripped);
        return projected === DROP ? null : projected;
      });
    }
    case "record": {
      if (!isPlainObject(value)) return dropKeyed(value, path, stripped);
      const valueType = def.valueType as ZodType;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const projected = project(valueType, item, `${path}{}`, stripped);
        if (projected !== DROP) out[key] = projected;
      }
      return out;
    }
    case "union":
      return projectUnion(def.options as ZodType[], value, path, stripped);
    default:
      if (SCALARS.has(def.type)) {
        if (def.type === "date" && value instanceof Date) return value;
        return dropKeyed(value, path, stripped);
      }
      // assertProjectable refuses every other construct at decoration time.
      throw new Error(`Response contract: unsupported Zod type "${def.type}"`);
  }
}

/** A value with nested keys where the schema declares none is dropped whole. */
function dropKeyed(
  value: unknown,
  path: string,
  stripped: Set<string>,
): unknown {
  if (!carriesKeys(value)) return value;
  stripped.add(path === "" ? "(root)" : path);
  return DROP;
}

function kindOf(value: unknown): "object" | "array" | "scalar" {
  if (Array.isArray(value)) return "array";
  return isPlainObject(value) ? "object" : "scalar";
}

/** The kind of value a union option accepts, looking through wrappers. */
function optionKind(schema: ZodType): "object" | "array" | "scalar" | "opaque" {
  let def = defOf(schema);
  while (WRAPPERS.has(def.type) || def.type === "lazy") {
    def = defOf(
      def.type === "lazy"
        ? (def.getter as () => ZodType)()
        : (def.innerType as ZodType),
    );
  }
  if (def.type === "object" || def.type === "record") return "object";
  if (def.type === "array") return "array";
  if (OPAQUE.has(def.type)) return "opaque";
  return "scalar";
}

function projectUnion(
  options: ZodType[],
  value: unknown,
  path: string,
  stripped: Set<string>,
): unknown {
  // The option the value satisfies, as zod would pick it; otherwise the first
  // option of the same kind, so undeclared keys are still dropped.
  const kind = kindOf(value);
  const chosen =
    options.find((option) => option.safeParse(value).success) ??
    options.find((option) => {
      const k = optionKind(option);
      return k === kind || k === "opaque";
    });
  if (chosen === undefined) return dropKeyed(value, path, stripped);
  return project(chosen, value, path, stripped);
}

// ============================================================================
// Decoration-time check
// ============================================================================

/**
 * Refuse schemas the projection cannot apply safely: open objects (a
 * catch-all would let new keys through), and anything that changes or hides
 * the value's shape (transforms, pipes, intersections, tuples, maps, sets,
 * custom checks). Output schemas describe data, so none of these is needed.
 */
export function assertProjectable(schema: ZodType): void {
  walk(schema, "", new Set());
}

function walk(schema: ZodType, path: string, seen: Set<ZodType>): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const def = defOf(schema);
  const at = path === "" ? "(root)" : path;

  if (WRAPPERS.has(def.type)) {
    walk(def.innerType as ZodType, path, seen);
    return;
  }
  if (OPAQUE.has(def.type) || SCALARS.has(def.type)) return;

  switch (def.type) {
    case "lazy":
      walk((def.getter as () => ZodType)(), path, seen);
      return;
    case "object": {
      const catchall = def.catchall as ZodType | undefined;
      if (catchall !== undefined && defOf(catchall).type !== "never") {
        throw new Error(
          `Response contract at ${at}: open objects (looseObject/catchall) are not allowed`,
        );
      }
      for (const [key, field] of Object.entries(
        def.shape as Record<string, ZodType>,
      )) {
        walk(field, join(path, key), seen);
      }
      return;
    }
    case "array":
      walk(def.element as ZodType, `${path}[]`, seen);
      return;
    case "record":
      walk(def.valueType as ZodType, `${path}{}`, seen);
      return;
    case "union":
      for (const option of def.options as ZodType[]) walk(option, path, seen);
      return;
    default:
      throw new Error(
        `Response contract at ${at}: Zod type "${def.type}" is not supported`,
      );
  }
}
