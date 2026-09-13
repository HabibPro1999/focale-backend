import type { NetworkingConfig } from "@app/contracts";
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}
function fieldsOf(schema: unknown) {
  const source = object(schema);
  const fields: RecordValue[] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value))
      for (const field of value)
        if (typeof object(field).id === "string") fields.push(object(field));
  };
  add(source.fields);
  for (const key of ["steps", "sponsorSteps"]) {
    if (Array.isArray(source[key]))
      for (const step of source[key] as unknown[]) add(object(step).fields);
  }
  add(object(source.beneficiaryTemplate).fields);
  return fields;
}
function optionValues(
  field: RecordValue,
  value: unknown,
  language: string,
): string[] {
  const options = Array.isArray(field.options) ? field.options.map(object) : [];
  const selected = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  for (const answer of selected) {
    if (typeof answer !== "string") continue;
    const option = options.find((candidate) => candidate.id === answer);
    if (!option) continue;
    const translated = object(object(option.translations)[language]).label;
    const label =
      typeof translated === "string" && translated.trim()
        ? translated
        : option.label;
    if (typeof label === "string" && label.trim()) result.push(label.trim());
  }
  return [...new Set(result)];
}
/** Project display labels, never option IDs; missing/deleted mappings clear stale machine values. */
export function projectNetworkingFields(
  schema: unknown,
  formData: RecordValue,
  config: Pick<NetworkingConfig, "fieldMapping" | "defaultLanguage">,
) {
  const fields = fieldsOf(schema);
  const projection: RecordValue = {};
  for (const [key, fieldId] of Object.entries(config.fieldMapping)) {
    if (key === "consent" || !fieldId) continue;
    const field = fields.find((value) => value.id === fieldId);
    const raw = field ? formData[fieldId] : undefined;
    const selectable =
      field && ["dropdown", "radio", "checkbox"].includes(String(field.type));
    const answer = selectable
      ? optionValues(field, raw, config.defaultLanguage)
      : raw;
    if (key === "interests") {
      projection[key] = (
        Array.isArray(answer)
          ? answer
          : typeof answer === "string"
            ? answer.split(/[,;]/)
            : []
      )
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 30);
    } else if (key === "website" || key === "photoUrl") {
      const value = typeof answer === "string" ? answer : object(answer).url;
      projection[key] =
        typeof value === "string" && /^https?:\/\//i.test(value)
          ? value.slice(0, 2048)
          : null;
    } else
      projection[key] = (
        Array.isArray(answer)
          ? answer.join(", ")
          : typeof answer === "string"
            ? answer
            : ""
      ).slice(0, ["offers", "seeks", "bio"].includes(key) ? 2000 : 200);
  }
  let consent = true;
  if (config.fieldMapping.consent) {
    const field = fields.find(
      (value) => value.id === config.fieldMapping.consent,
    );
    const answer = field ? formData[config.fieldMapping.consent] : undefined;
    consent =
      answer === true ||
      (typeof answer === "string" && /^(true|yes|on|1)$/i.test(answer)) ||
      !!(field && optionValues(field, answer, config.defaultLanguage).length);
  }
  return { projection, consent };
}
