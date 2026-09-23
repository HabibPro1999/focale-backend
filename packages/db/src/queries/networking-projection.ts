import { NETWORKING_PROFESSIONAL_FIELDS, type NetworkingConfig } from "@app/contracts";
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
export type NetworkingMappedConsent = "yes" | "no" | "unanswered";
// NFKC folds compatibility forms; apostrophes are unified and Arabic diacritics/tatweel ignored.
function consentText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B\u02BC\u2032\u00B4\u0060]/g, "'")
    .toLowerCase()
    .replace(/[\u0640\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
// Leading phrases only; a phrase must end at a non-letter/digit so "None" is not "no".
const leading = (phrases: string[]) =>
  new RegExp(`^(?:${phrases.join("|")})(?![\\p{L}\\p{N}])`, "u");
const negativeConsent = leading(["no", "non", "i do not", "i don't", "je ne", "je refuse", "refuse", "decline", "لا"]);
const elidedNegative = /^je n'/;
const affirmativeConsent = leading(["yes", "oui", "i agree", "agree", "i accept", "accept", "j'accepte", "d'accord", "نعم", "أوافق", "موافق", "أقبل"]);
const scalarConsent = new Map<string, NetworkingMappedConsent>([
  ["true", "yes"], ["on", "yes"], ["1", "yes"], ["false", "no"], ["off", "no"], ["0", "no"],
]);
/** Negative wording is checked first so "Non, je refuse" or "No, I don't agree" never counts as consent. */
export function networkingConsentText(value: string): NetworkingMappedConsent {
  const text = consentText(value);
  const scalar = scalarConsent.get(text);
  if (scalar) return scalar;
  if (negativeConsent.test(text) || elidedNegative.test(text)) return "no";
  return affirmativeConsent.test(text) ? "yes" : "unanswered";
}
function consentAnswer(field: RecordValue, answer: unknown): NetworkingMappedConsent {
  if (typeof answer === "boolean") return answer ? "yes" : "no";
  const options = Array.isArray(field.options) ? field.options.map(object) : [];
  if (!["radio", "select", "dropdown", "checkbox", "multi"].includes(String(field.type)) || !options.length)
    return typeof answer === "string" ? networkingConsentText(answer) : "unanswered";
  const selected = Array.isArray(answer) ? answer : [answer];
  // Option IDs are machine values and never express consent; only labels/values do.
  const verdicts = options
    .filter((option) => selected.includes(option.id))
    .map((option) => {
      const labels = [option.value, option.label, ...Object.values(object(option.translations)).map((translation) => object(translation).label)]
        .filter((value): value is string => typeof value === "string" && !!value.trim())
        .map(networkingConsentText);
      return labels.includes("no") ? "no" : labels.includes("yes") ? "yes" : "unanswered";
    });
  if (!verdicts.length) return "unanswered";
  if (verdicts.includes("no")) return "no";
  if (verdicts.includes("yes")) return "yes";
  // A lone checkbox ("I want to take part in networking") is consent when ticked.
  return String(field.type) === "checkbox" && options.length === 1 ? "yes" : "unanswered";
}
/**
 * K1 consent resolution: a registration opt-in boolean decides; otherwise the participant's
 * explicit choice, then the mapped form answer. Undecided registrants may sign in to choose.
 */
export function resolveNetworkingConsent(input: {
  optIn: boolean | null | undefined;
  choice: unknown;
  mapped: NetworkingMappedConsent;
  withdrawn: boolean;
}) {
  if (input.optIn === false || input.withdrawn || input.choice === false)
    return { consent: false, undecided: false };
  if (input.optIn === true || input.choice === true || input.mapped === "yes")
    return { consent: true, undecided: false };
  return { consent: false, undecided: input.mapped === "unanswered" };
}
/**
 * K1b: an unconsented profile whose registration leaves consent undecided (no opt-in boolean,
 * no explicit participant choice, mapped answer not "no") may sign in to choose in the PWA.
 */
export function networkingConsentPending(input: {
  profile: { consent: boolean; withdrawnAt: Date | null; overrides: unknown };
  optIn: boolean | null | undefined;
  formSchema: unknown;
  formData: unknown;
  config: Pick<NetworkingConfig, "fieldMapping" | "defaultLanguage">;
}) {
  if (input.profile.consent || input.profile.withdrawnAt) return false;
  const { consent: mapped } = projectNetworkingFields(input.formSchema, object(input.formData), input.config);
  const resolved = resolveNetworkingConsent({
    optIn: input.optIn, choice: object(input.profile.overrides).consent, mapped, withdrawn: false,
  });
  return resolved.consent || resolved.undecided;
}
/** Field definition by id across single-page, multi-step and sponsor form schemas. */
export function networkingFormField(schema: unknown, fieldId: string) {
  return fieldsOf(schema).find((field) => field.id === fieldId);
}
/** Project display labels, never option IDs; missing/deleted mappings clear stale machine values. */
export function projectNetworkingFields(
  schema: unknown,
  formData: RecordValue,
  config: Pick<NetworkingConfig, "fieldMapping" | "defaultLanguage">,
) {
  const fields = fieldsOf(schema);
  const projection: RecordValue = Object.fromEntries(NETWORKING_PROFESSIONAL_FIELDS.map(key =>
    [key, key === "interests" ? [] : key === "website" || key === "photoUrl" ? null : ""]));
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
  // An unmapped or deleted consent field is unanswered: the opt-in or the participant decides.
  let consent: NetworkingMappedConsent = "unanswered";
  const consentField = config.fieldMapping.consent
    ? fields.find((value) => value.id === config.fieldMapping.consent)
    : undefined;
  if (consentField) consent = consentAnswer(consentField, formData[String(consentField.id)]);
  return { projection, consent };
}
