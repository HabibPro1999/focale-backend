const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

/**
 * Escapes HTML special characters to prevent XSS / markup injection.
 * Shared between the email renderer and the abstract sanitizer so the two
 * cannot drift apart.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]!);
}

// Only treat `<` as the start of a tag when it is immediately followed by a
// letter (optionally preceded by `/` for a closing tag). This mirrors the
// HTML5 rule and keeps prose such as "p < 0.05 and n > 30" as literal text
// instead of swallowing it as a bogus tag.
const TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/g;
const ENTITY_PATTERN = /&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi;

// Convert a numeric code point into a string, dropping anything that would be
// invalid (out of the Unicode range), a lone surrogate, or a control character.
function safeFromCodePoint(codePoint: number): string {
  if (!Number.isInteger(codePoint)) return "";
  if (codePoint > 0x10ffff) return "";
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return "";
  // Allow tab and newline; drop every other C0/C1 control char and DEL.
  if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) return "";
  if (codePoint >= 0x7f && codePoint <= 0x9f) return "";
  return String.fromCodePoint(codePoint);
}

function decodeEntity(entity: string): string {
  const value = entity.slice(1, -1).toLowerCase();
  if (value === "nbsp") return " ";
  if (value === "amp") return "&";
  if (value === "lt") return "<";
  if (value === "gt") return ">";
  if (value === "quot") return '"';
  if (value === "apos") return "'";
  if (value.startsWith("#x")) {
    return safeFromCodePoint(Number.parseInt(value.slice(2), 16));
  }
  if (value.startsWith("#")) {
    return safeFromCodePoint(Number.parseInt(value.slice(1), 10));
  }
  return entity;
}

/** Decode the small fixed set of named/numeric HTML entities used by abstracts. */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (entity) => decodeEntity(entity));
}

/**
 * Strip abstract HTML down to plain text. Block tags become newlines and any
 * remaining (inline) tags become a space so neighbouring words are not glued
 * together — e.g. "<strong>one</strong><strong>two</strong>" counts as two
 * words, not one, otherwise word limits can be bypassed.
 */
export function abstractHtmlToText(input: string): string {
  if (!input) return "";
  const withBreaks = input
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|li|ul|ol)\s*>/gi, "\n")
    .replace(/<\s*(p|ul|ol|li)(\s[^>]*)?>/gi, "\n");
  return decodeEntities(withBreaks.replace(TAG_PATTERN, " "))
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
