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
const DATE_LOCALES: Record<LanguageCode, string> = {
  fr: "fr-FR",
  en: "en-US",
  ar: "ar-TN",
};

/** Long date: "24 septembre 2026", "September 24, 2026", "24 سبتمبر 2026". */
export function formatDate(
  date: Date | string | null | undefined,
  language: LanguageCode,
): string {
  if (!date) return "";
  const d = new Date(date);
  return d.toLocaleDateString(DATE_LOCALES[language], {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
