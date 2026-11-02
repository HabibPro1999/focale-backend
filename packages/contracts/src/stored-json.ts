import type { z } from "zod";

// Stored JSON documents (plan 5.2). A JSONB column typed with a Zod schema
// holds exactly that schema's parsed output: what the write path stores after
// validating a request. `checkStoredJson` tells whether a value read back is
// still such a document. It is pure (no I/O, no logging); @app/db applies it
// at read boundaries (parseJsonb) and the audit script over whole tables.
//
// Issues carry a path and a code only, never the offending value: stored
// documents hold registrant answers and email variables.

/** A Zod schema describing a stored JSON document. */
export type StoredJsonSchema = z.ZodType;
/** The document type a stored-JSON schema describes (its parsed output). */
export type StoredJsonOf<S extends StoredJsonSchema> = z.output<S>;

export interface StoredJsonIssue {
  /** Where in the document, e.g. `[0].conditions[1].operator`; `(root)` for the value itself. */
  path: string;
  /**
   * A Zod issue code (`invalid_type`, `unrecognized_keys`, ...), or a
   * canonical-form code: `missing_default` (a key with a schema default is
   * absent, so the stored value is not the parsed output), `stripped_key` or
   * `changed_value` (parsing would drop or rewrite something).
   */
  code: string;
}

type PathSegment = PropertyKey;

export function formatStoredJsonPath(path: readonly PathSegment[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out === "" ? "(root)" : out;
}

type ZodIssue = z.core.$ZodIssue;

/**
 * The issues of the union option the value most likely meant: the one whose
 * first problem sits deepest (it matched the most structure), then the one
 * with the fewest issues, then the first. Reporting every option's issues
 * would bury the one real problem under "missing key" noise from the others.
 */
function bestUnionBranch(errors: readonly (readonly ZodIssue[])[]): readonly ZodIssue[] {
  let best: readonly ZodIssue[] = [];
  let bestDepth = -1;
  for (const issues of errors) {
    const depth = issues.length === 0 ? 0 : Math.min(...issues.map((i) => i.path.length));
    if (depth > bestDepth || (depth === bestDepth && issues.length < best.length)) {
      best = issues;
      bestDepth = depth;
    }
  }
  return best;
}

function collectIssues(
  issues: readonly ZodIssue[],
  prefix: readonly PathSegment[],
  out: StoredJsonIssue[],
): void {
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      collectIssues(bestUnionBranch(issue.errors), path, out);
    } else if (issue.code === "unrecognized_keys") {
      // Key names are field names, not values: name each one.
      for (const key of issue.keys) {
        out.push({ path: formatStoredJsonPath([...path, key]), code: issue.code });
      }
    } else {
      out.push({ path: formatStoredJsonPath(path), code: issue.code });
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Where the parsed output differs from the stored value. Key order is
 * ignored (JSONB does not keep it); an absent key and an `undefined` value are
 * the same thing (JSON has no undefined).
 */
function diffCanonical(
  stored: unknown,
  parsed: unknown,
  path: PathSegment[],
  out: StoredJsonIssue[],
): void {
  if (Object.is(stored, parsed)) return;
  if (Array.isArray(parsed)) {
    if (!Array.isArray(stored) || stored.length !== parsed.length) {
      out.push({ path: formatStoredJsonPath(path), code: "changed_value" });
      return;
    }
    parsed.forEach((item, index) => diffCanonical(stored[index], item, [...path, index], out));
    return;
  }
  if (isPlainObject(parsed)) {
    if (!isPlainObject(stored)) {
      out.push({ path: formatStoredJsonPath(path), code: "changed_value" });
      return;
    }
    const keys = new Set([...Object.keys(stored), ...Object.keys(parsed)]);
    for (const key of keys) {
      const before = stored[key];
      const after = parsed[key];
      if (before === undefined && after === undefined) continue;
      const at = [...path, key];
      if (before === undefined) {
        out.push({ path: formatStoredJsonPath(at), code: "missing_default" });
      } else if (after === undefined) {
        out.push({ path: formatStoredJsonPath(at), code: "stripped_key" });
      } else {
        diffCanonical(before, after, at, out);
      }
    }
    return;
  }
  out.push({ path: formatStoredJsonPath(path), code: "changed_value" });
}

/**
 * Issues that keep `value` from being a stored `schema` document; empty when
 * it is one. A value is a stored document when the schema accepts it and
 * parsing it changes nothing (no default filled in, no key dropped, no value
 * rewritten), so the value read from the database already has the schema's
 * output type as it is.
 */
export function checkStoredJson(schema: StoredJsonSchema, value: unknown): StoredJsonIssue[] {
  const result = schema.safeParse(value);
  const issues: StoredJsonIssue[] = [];
  if (!result.success) {
    collectIssues(result.error.issues, [], issues);
  } else {
    diffCanonical(value, result.data, [], issues);
  }
  return issues;
}
