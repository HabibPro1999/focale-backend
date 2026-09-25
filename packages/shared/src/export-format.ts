// =============================================================================
// EXPORT FORMAT
// One policy for every CSV / XLSX / ZIP export: dates in the event's time zone,
// safe CSV cells, and valid, unique worksheet and ZIP entry names.
// =============================================================================

/**
 * Time zone for dates shown in exports. Events carry no time-zone column yet
 * and all of them are Tunisia-based; the server itself runs in UTC.
 */
export const DEFAULT_EVENT_TIME_ZONE = "Africa/Tunis";

export type ExportLang = "fr" | "en" | "ar";

const LOCALES: Record<ExportLang, string> = {
  fr: "fr-FR",
  en: "en-US",
  ar: "ar-TN",
};

/** `dd/mm/yyyy HH:MM` (per language) in the event's time zone. */
export function formatDateTime(
  date: Date,
  lang: ExportLang = "fr",
  timeZone: string = DEFAULT_EVENT_TIME_ZONE,
): string {
  return date.toLocaleString(LOCALES[lang], {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `dd/mm/yyyy` (per language) in the event's time zone. */
export function formatDate(
  date: Date,
  lang: ExportLang = "fr",
  timeZone: string = DEFAULT_EVENT_TIME_ZONE,
): string {
  return date.toLocaleDateString(LOCALES[lang], {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** `HH:MM` (per language) in the event's time zone. */
export function formatTime(
  date: Date,
  lang: ExportLang = "fr",
  timeZone: string = DEFAULT_EVENT_TIME_ZONE,
): string {
  return date.toLocaleTimeString(LOCALES[lang], {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `YYYY-MM-DD` in the event's time zone, for export file names. */
export function formatFileDate(
  date: Date = new Date(),
  timeZone: string = DEFAULT_EVENT_TIME_ZONE,
): string {
  // en-CA formats as YYYY-MM-DD.
  return date.toLocaleDateString("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

// -----------------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------------

// A spreadsheet app evaluates a cell starting with = + - @ (after any leading
// whitespace or control characters) as a formula, and a leading tab/CR/LF can
// hide one. Such text is prefixed with an apostrophe. Numbers stay as numbers.
// eslint-disable-next-line no-control-regex -- control characters are what it matches
const CSV_FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@]/;
const CSV_HIDDEN_START = /^[\t\r\n]/;

/** One quoted CSV cell, with the formula-injection guard applied to text. */
export function csvCell(value: unknown): string {
  if (typeof value === "number" || typeof value === "bigint") {
    return `"${String(value)}"`;
  }
  let text = value instanceof Date ? value.toISOString() : String(value ?? "");
  if (CSV_FORMULA_START.test(text) || CSV_HIDDEN_START.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** RFC 4180 CSV (CRLF) with a UTF-8 BOM, so spreadsheet apps read accents and Arabic. */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

// XLSX needs no escaping: a string cell is stored as text and never evaluated,
// so exports write plain strings (no apostrophe prefix, which would show).

// -----------------------------------------------------------------------------
// Worksheet and ZIP entry names
// -----------------------------------------------------------------------------

const SHEET_NAME_MAX = 31;

function truncate(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/**
 * A valid worksheet name, unique (case-insensitively) within `used`, which it
 * updates. Excel forbids `[]:*?/\`, a leading or trailing apostrophe, more than
 * 31 characters, an empty name and "History"; duplicates get " (2)", " (3)"….
 */
export function uniqueSheetName(
  name: string,
  used: Set<string>,
  fallback = "Sheet",
): string {
  let base = name
    // eslint-disable-next-line no-control-regex -- control characters are removed
    .replace(/[\u0000-\u001f[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "")
    .trim();
  if (!base || base.toLowerCase() === "history") base = fallback;
  base = truncate(base, SHEET_NAME_MAX).trim();

  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = `${truncate(base, SHEET_NAME_MAX - suffix.length).trim()}${suffix}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** ASCII slug: accents folded ("Déjeuner" → "dejeuner"), other characters dropped. */
export function asciiSlug(text: string, maxLength = 50): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/**
 * A ZIP entry name `<slug><suffix>`, unique (case-insensitively) within `used`,
 * which it updates. Names with no ASCII letters or digits (e.g. Arabic) use
 * `fallback`; duplicates get "-2", "-3"….
 */
export function uniqueFileName(
  name: string,
  suffix: string,
  used: Set<string>,
  fallback = "file",
): string {
  const base = asciiSlug(name) || fallback;
  let candidate = `${base}${suffix}`;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${base}-${n}${suffix}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
