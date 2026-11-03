// =============================================================================
// LOCALE
// Formats template variables in the subject's primary language: the first
// entry of the registration form's settings.languages (or of the abstract
// config's languages), fr when unset — resolved by @app/db with
// getPrimaryLanguage.
// =============================================================================

import type { LanguageCode } from "@app/contracts";

// ar-TN gives Latin digits and the Tunisian month names (جانفي، أفريل، أوت)
// rather than the يناير/أغسطس forms plain `ar` produces.
export const EMAIL_LOCALES: Record<LanguageCode, string> = {
  fr: "fr-FR",
  en: "en-US",
  ar: "ar-TN",
};

const LONG_DATE: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
};

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A Date from a stored value. A bare "YYYY-MM-DD" (a form's date answer) is
 * read at noon UTC, so its day never shifts in any server timezone.
 */
function toDate(date: Date | string): Date {
  if (typeof date === "string" && ISO_DAY.test(date)) {
    return new Date(`${date}T12:00:00Z`);
  }
  return new Date(date);
}

/** Long date: "24 septembre 2026", "September 24, 2026", "24 سبتمبر 2026". */
export function formatDate(
  date: Date | string | null | undefined,
  language: LanguageCode,
): string {
  if (!date) return "";
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(EMAIL_LOCALES[language], LONG_DATE);
}

/**
 * An event's dates as one range: the long date for a one-day event,
 * "20–22 novembre 2026" / "November 20–22, 2026" / "20–22 نوفمبر 2026" within
 * one month, else "start – end" in long dates. Days are read in the same
 * timezone as formatDate.
 */
export function formatDateRange(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
  language: LanguageCode,
): string {
  if (!start) return formatDate(end, language);
  if (!end) return formatDate(start, language);
  const from = toDate(start);
  const to = toDate(end);
  if (Number.isNaN(from.getTime())) return formatDate(end, language);
  if (Number.isNaN(to.getTime())) return formatDate(start, language);

  const formatter = new Intl.DateTimeFormat(EMAIL_LOCALES[language], LONG_DATE);
  const fromParts = formatter.formatToParts(from);
  const toParts = formatter.formatToParts(to);
  const part = (parts: Intl.DateTimeFormatPart[], type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const sameYear = part(fromParts, "year") === part(toParts, "year");
  const sameMonth = sameYear && part(fromParts, "month") === part(toParts, "month");
  if (sameMonth && part(fromParts, "day") === part(toParts, "day")) {
    return formatter.format(from);
  }
  if (sameMonth) {
    // The end date with its day replaced by "startDay–endDay".
    const days = `${part(fromParts, "day")}–${part(toParts, "day")}`;
    return toParts.map((p) => (p.type === "day" ? days : p.value)).join("");
  }
  return `${formatter.format(from)} – ${formatter.format(to)}`;
}
