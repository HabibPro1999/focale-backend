import { forms, getDb } from "@app/db";

/**
 * Read-only report of form-field conditions that the public form app
 * evaluates differently from what the admin configured (see
 * `packages/shared/src/field-visibility.ts`, the server's exact port). Since
 * 2.11 the server hides/requires fields exactly as the form app does, so these
 * quirks now apply on both sides. Fixing a form (e.g. lowercasing its logic)
 * changes what its registrants see, so it is a per-form decision; this report
 * only lists candidates and writes nothing.
 */

export type FormConditionFindingKind =
  /** `conditionLogic` is not lowercase: the form app treats anything but `'and'` as OR. */
  | "UPPERCASE_LOGIC"
  /** A text comparison with a non-string value: the form app throws once the field is answered. */
  | "NON_STRING_VALUE"
  /** An operator the form app does not know: the condition never matches. */
  | "UNKNOWN_OPERATOR"
  /** The condition reads a field the form does not have: it compares against an empty answer. */
  | "UNKNOWN_FIELD";

export interface FormConditionFinding {
  kind: FormConditionFindingKind;
  formId: string;
  formName: string;
  eventId: string;
  formType: string;
  active: boolean;
  fieldId: string;
  /** For UPPERCASE_LOGIC: lowercasing would change who sees the field. */
  changesVisibility?: boolean;
  detail: string;
}

export interface FormRowForConditionReport {
  id: string;
  name: string;
  eventId: string;
  type: string;
  active: boolean;
  schema: unknown;
}

const KNOWN_OPERATORS = new Set([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "less_than",
]);
// Operators whose form-app implementation calls `.toLowerCase()` on the value.
const TEXT_OPERATORS = new Set(["equals", "not_equals", "contains", "not_contains"]);

interface ReportField {
  id?: unknown;
  conditions?: unknown;
  conditionLogic?: unknown;
}

function fieldLists(schema: unknown): ReportField[][] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as {
    steps?: unknown;
    sponsorSteps?: unknown;
    beneficiaryTemplate?: { fields?: unknown; steps?: unknown };
  };
  const fromSteps = (steps: unknown): ReportField[][] =>
    Array.isArray(steps)
      ? steps
          .map((step) => (step as { fields?: unknown } | null)?.fields)
          .filter(Array.isArray)
      : [];
  const lists = [
    ...fromSteps(s.steps),
    ...fromSteps(s.sponsorSteps),
    ...fromSteps(s.beneficiaryTemplate?.steps),
  ];
  if (Array.isArray(s.beneficiaryTemplate?.fields)) {
    lists.push(s.beneficiaryTemplate.fields as ReportField[]);
  }
  return lists as ReportField[][];
}

function describeValue(value: unknown): string {
  return value === undefined ? "no value" : `${typeof value} ${JSON.stringify(value)}`;
}

/** Findings for one form's schema (pure; no I/O). */
export function scanFormConditions(
  form: FormRowForConditionReport,
): FormConditionFinding[] {
  const lists = fieldLists(form.schema);
  const fields = lists.flat().filter((f) => f && typeof f === "object");
  const fieldIds = new Set(fields.map((f) => f.id).filter((id) => typeof id === "string"));
  const findings: FormConditionFinding[] = [];
  const base = {
    formId: form.id,
    formName: form.name,
    eventId: form.eventId,
    formType: form.type,
    active: form.active,
  };

  for (const field of fields) {
    const conditions = Array.isArray(field.conditions) ? field.conditions : [];
    if (conditions.length === 0) continue;
    const fieldId = String(field.id);
    const logic = field.conditionLogic;

    if (logic !== undefined && logic !== "and" && logic !== "or") {
      const changesVisibility = logic !== "OR" && conditions.length > 1;
      findings.push({
        ...base,
        kind: "UPPERCASE_LOGIC",
        fieldId,
        changesVisibility,
        detail: changesVisibility
          ? `conditionLogic ${JSON.stringify(logic)} with ${conditions.length} conditions is evaluated as OR; lowercasing to "and" changes who sees this field`
          : `conditionLogic ${JSON.stringify(logic)} is evaluated as OR; lowercasing does not change who sees this field`,
      });
    }

    for (const raw of conditions) {
      const condition = (raw ?? {}) as { fieldId?: unknown; operator?: unknown; value?: unknown };
      const operator = String(condition.operator);
      if (!KNOWN_OPERATORS.has(operator)) {
        findings.push({
          ...base,
          kind: "UNKNOWN_OPERATOR",
          fieldId,
          detail: `operator ${JSON.stringify(condition.operator)} never matches in the form app`,
        });
      } else if (TEXT_OPERATORS.has(operator) && typeof condition.value !== "string") {
        findings.push({
          ...base,
          kind: "NON_STRING_VALUE",
          fieldId,
          detail: `"${operator}" on field ${JSON.stringify(condition.fieldId)} has ${describeValue(condition.value)}; the form app throws once that field has a text or checkbox answer (the server rejects the submission)`,
        });
      }
      if (typeof condition.fieldId !== "string" || !fieldIds.has(condition.fieldId)) {
        findings.push({
          ...base,
          kind: "UNKNOWN_FIELD",
          fieldId,
          detail: `condition reads field ${JSON.stringify(condition.fieldId)}, which this form does not have; it compares against an empty answer`,
        });
      }
    }
  }
  return findings;
}

/**
 * Scan every form in one READ ONLY transaction. Writes nothing.
 */
export async function loadFormConditionReport(): Promise<{
  scanned: number;
  findings: FormConditionFinding[];
}> {
  const rows = await getDb().transaction(
    (tx) =>
      tx
        .select({
          id: forms.id,
          name: forms.name,
          eventId: forms.eventId,
          type: forms.type,
          active: forms.active,
          schema: forms.schema,
        })
        .from(forms)
        .orderBy(forms.eventId, forms.id),
    { accessMode: "read only" },
  );
  return { scanned: rows.length, findings: rows.flatMap(scanFormConditions) };
}

export function formatFormConditionReport(report: {
  scanned: number;
  findings: FormConditionFinding[];
}): string[] {
  const lines = report.findings.map(
    (f) =>
      `[${f.kind}] form ${f.formId} ${JSON.stringify(f.formName)} (event ${f.eventId}, ${f.formType}${f.active ? "" : ", inactive"}) field ${JSON.stringify(f.fieldId)}: ${f.detail}`,
  );
  const formsWith = (kind: FormConditionFindingKind, extra?: (f: FormConditionFinding) => boolean) =>
    new Set(
      report.findings
        .filter((f) => f.kind === kind && (extra ? extra(f) : true))
        .map((f) => f.formId),
    ).size;
  lines.push(
    `Scanned ${report.scanned} form(s): ${formsWith("UPPERCASE_LOGIC")} with uppercase conditionLogic ` +
      `(${formsWith("UPPERCASE_LOGIC", (f) => f.changesVisibility === true)} where lowercasing changes visibility), ` +
      `${formsWith("NON_STRING_VALUE")} with non-string condition values, ` +
      `${formsWith("UNKNOWN_OPERATOR")} with unknown operators, ` +
      `${formsWith("UNKNOWN_FIELD")} with conditions on missing fields. Nothing was changed.`,
  );
  return lines;
}
