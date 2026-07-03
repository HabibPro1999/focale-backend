// ponytail: faithful port of apps/api abstracts.html.ts `abstractHtmlToText`
// (+ its decodeEntities/safeFromCodePoint). The worker cannot import apps/api,
// and stored abstract content is already sanitized at submission, so this is a
// plain-text extractor only. Keep in sync with the api copy if that changes.

const TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/g;
const ENTITY_PATTERN = /&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi;

function safeFromCodePoint(codePoint: number): string {
  if (!Number.isInteger(codePoint)) return "";
  if (codePoint > 0x10ffff) return "";
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return "";
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

function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (entity) => decodeEntity(entity));
}

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
