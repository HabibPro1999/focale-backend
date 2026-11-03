// =============================================================================
// FORM ANSWER VALUES (form_* variables)
// A registration's stored answers as the words a registrant reads, by the
// field's type in the registration form schema: option labels rather than
// option ids, country names rather than ISO codes, long dates rather than
// "YYYY-MM-DD", and never "[object Object]".
// =============================================================================

import type { LanguageCode } from "@app/contracts";
import { EMAIL_LOCALES, formatDate } from "./locale";
import { joinLabels, YES_NO } from "./format";

interface FormFieldOption {
  id: string;
  /** A string; older forms may hold a per-language object. */
  label?: unknown;
  translations?: Partial<Record<LanguageCode, { label?: string }>>;
}

/** What formatting a form answer needs from its schema field. */
export interface FormFieldInfo {
  type: string;
  options?: readonly FormFieldOption[];
}

/** A registration form's fields by id. */
export type FormFieldIndex = ReadonlyMap<string, FormFieldInfo>;

const EMPTY_INDEX: FormFieldIndex = new Map();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields of a stored form schema (`steps[].fields[]`), by id. */
export function indexFormFields(schema: unknown): FormFieldIndex {
  if (!isRecord(schema) || !Array.isArray(schema.steps)) return EMPTY_INDEX;
  const index = new Map<string, FormFieldInfo>();
  for (const step of schema.steps) {
    if (!isRecord(step) || !Array.isArray(step.fields)) continue;
    for (const field of step.fields) {
      if (!isRecord(field) || typeof field.id !== "string") continue;
      index.set(field.id, {
        type: typeof field.type === "string" ? field.type : "text",
        options: Array.isArray(field.options)
          ? (field.options.filter(
              (o) => isRecord(o) && typeof o.id === "string",
            ) as unknown as FormFieldOption[])
          : undefined,
      });
    }
  }
  return index;
}

// The form app's built-in governorate list (form/src/constants/governorates.ts),
// for a governorate field whose schema carries no options.
const TUNISIA_GOVERNORATES: Record<string, string> = {
  ariana: "Ariana",
  beja: "Béja",
  "ben-arous": "Ben Arous",
  bizerte: "Bizerte",
  gabes: "Gabès",
  gafsa: "Gafsa",
  jendouba: "Jendouba",
  kairouan: "Kairouan",
  kasserine: "Kasserine",
  kebili: "Kébili",
  kef: "Le Kef",
  mahdia: "Mahdia",
  manouba: "Manouba",
  medenine: "Médenine",
  monastir: "Monastir",
  nabeul: "Nabeul",
  sfax: "Sfax",
  "sidi-bouzid": "Sidi Bouzid",
  siliana: "Siliana",
  sousse: "Sousse",
  tataouine: "Tataouine",
  tozeur: "Tozeur",
  tunis: "Tunis",
  zaghouan: "Zaghouan",
};

/** An option's label in the language: its translation, else its label; trimmed. */
function optionLabel(option: FormFieldOption, language: LanguageCode): string {
  const translated = option.translations?.[language]?.label?.trim();
  if (translated) return translated;
  const label = option.label;
  if (typeof label === "string") return label.trim();
  if (isRecord(label)) {
    const localized = label[language] ?? label.fr ?? label.en;
    return typeof localized === "string" ? localized.trim() : "";
  }
  return "";
}

function findOption(field: FormFieldInfo, id: string): FormFieldOption | undefined {
  return field.options?.find((option) => option.id === id);
}

function countryName(code: string, language: LanguageCode): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "";
  try {
    const name = new Intl.DisplayNames([EMAIL_LOCALES[language]], {
      type: "region",
    }).of(code.toUpperCase());
    return name && name.toUpperCase() !== code.toUpperCase() ? name : "";
  } catch {
    return "";
  }
}

/** A file answer's name when the stored value carries one, else "". */
function fileName(value: unknown): string {
  if (!isRecord(value)) return "";
  for (const key of ["name", "fileName", "originalName"]) {
    const name = value[key];
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return "";
}

/** A primitive answer as text (no schema): booleans in words, objects blank. */
function plainValue(value: unknown, language: LanguageCode): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") {
    return value ? YES_NO[language].yes : YES_NO[language].no;
  }
  if (value instanceof Date) return formatDate(value, language);
  if (typeof value === "object") return "";
  return String(value);
}

/** Primitives of an array, as text, blanks dropped. */
function plainList(values: unknown[], language: LanguageCode): string {
  return joinLabels(
    values.map((v) => plainValue(v, language)).filter(Boolean),
    language,
  );
}

/** The selected options' labels, in option order; unknown ids drop. */
function selectedLabels(
  field: FormFieldInfo,
  ids: readonly unknown[],
  language: LanguageCode,
): string {
  const selected = new Set(ids.map(String));
  const labels = (field.options ?? [])
    .filter((option) => selected.has(option.id))
    .map((option) => optionLabel(option, language))
    .filter(Boolean);
  return joinLabels(labels, language);
}

function formatCheckbox(
  field: FormFieldInfo,
  value: unknown,
  language: LanguageCode,
): string {
  if (typeof value === "boolean") return plainValue(value, language);
  const ids = Array.isArray(value)
    ? value
    : value === null || value === undefined || value === ""
      ? []
      : [value];
  const options = field.options ?? [];
  // A lone box (a consent box): Yes when ticked, rather than its sentence.
  if (options.length === 1) {
    return ids.map(String).includes(options[0].id) ? YES_NO[language].yes : "";
  }
  return selectedLabels(field, ids, language);
}

function formatChoice(
  field: FormFieldInfo,
  value: unknown,
  language: LanguageCode,
): string {
  if (Array.isArray(value)) return selectedLabels(field, value, language);
  if (typeof value !== "string" && typeof value !== "number") return "";
  const option = findOption(field, String(value));
  if (option) return optionLabel(option, language);
  if (field.type === "governorate") {
    return TUNISIA_GOVERNORATES[String(value)] ?? "";
  }
  return "";
}

function formatCountry(
  field: FormFieldInfo,
  value: unknown,
  language: LanguageCode,
): string {
  if (typeof value !== "string" || !value) return "";
  const option = findOption(field, value);
  return (
    countryName(value, language) ||
    (option ? optionLabel(option, language) : "") ||
    value
  );
}

/**
 * One stored answer as text in `language`, by its schema field's type; without
 * a field (a removed field, no schema), primitives as stored and objects blank.
 */
export function formatFormValue(
  value: unknown,
  field: FormFieldInfo | undefined,
  language: LanguageCode,
): string {
  if (value === null || value === undefined) return "";
  switch (field?.type) {
    case "dropdown":
    case "radio":
    case "governorate":
      return formatChoice(field, value, language);
    case "checkbox":
      return formatCheckbox(field, value, language);
    case "country":
      return formatCountry(field, value, language);
    case "date":
      return typeof value === "string" || value instanceof Date
        ? formatDate(value, language)
        : "";
    case "file":
      return fileName(value);
    default:
      return Array.isArray(value)
        ? plainList(value, language)
        : plainValue(value, language);
  }
}

/** Every answer of `formData` as its `form_<fieldId>` variable. */
export function formatFormData(
  formData: Record<string, unknown>,
  fields: FormFieldIndex | null | undefined,
  language: LanguageCode,
): Record<`form_${string}`, string> {
  const values: Record<`form_${string}`, string> = {};
  for (const [key, value] of Object.entries(formData)) {
    values[`form_${key}`] = formatFormValue(value, fields?.get(key), language);
  }
  return values;
}

/** A sample answer for a field (the variable picker, preview and test sends). */
export function sampleFormValue(
  field: FormFieldInfo,
  language: LanguageCode,
): string | undefined {
  const firstOption = field.options?.[0]?.id;
  switch (field.type) {
    case "dropdown":
    case "radio":
      return firstOption ? formatFormValue(firstOption, field, language) : undefined;
    case "governorate":
      return formatFormValue(firstOption ?? "tunis", field, language);
    case "checkbox":
      return firstOption ? formatFormValue([firstOption], field, language) : undefined;
    case "country":
      return formatFormValue("TN", field, language);
    case "date":
      return formatFormValue("2025-03-15", field, language);
    default:
      return undefined;
  }
}
