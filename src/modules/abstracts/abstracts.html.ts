import { escapeHtml } from "@shared/utils/html.js";

const ALLOWED_TAGS = new Set(["p", "br", "strong", "em", "u", "ul", "ol", "li"]);
const VOID_TAGS = new Set(["br"]);
// Only treat `<` as the start of a tag when it is immediately followed by a
// letter (optionally preceded by `/` for a closing tag). This mirrors the
// HTML5 rule and keeps prose such as "p < 0.05 and n > 30" as literal text
// instead of swallowing it as a bogus tag.
const TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/g;
const ENTITY_PATTERN = /&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi;

type AbstractContent =
  | { mode: "FREE_TEXT"; title: string; body: string }
  | {
      mode: "STRUCTURED";
      title: string;
      introduction: string;
      objective: string;
      methods: string;
      results: string;
      conclusion: string;
    };

const STRUCTURED_SECTIONS = [
  "introduction",
  "objective",
  "methods",
  "results",
  "conclusion",
] as const;

// Convert a numeric code point into a string, dropping anything that would be
// invalid (out of the Unicode range), a lone surrogate, or a control character.
// String.fromCodePoint throws a RangeError on out-of-range values, and NUL /
// surrogates cannot be stored in a JSON/text column, so both would otherwise
// turn a crafted entity into a 500.
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
  if (value === "quot") return "\"";
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

function normalizeTagName(rawName: string): string {
  const name = rawName.toLowerCase();
  if (name === "b") return "strong";
  if (name === "i") return "em";
  return name;
}

export function sanitizeAbstractHtml(input: string): string {
  if (!input) return "";

  let output = "";
  let lastIndex = 0;
  for (const match of input.matchAll(TAG_PATTERN)) {
    const index = match.index ?? 0;
    output += escapeHtml(decodeEntities(input.slice(lastIndex, index)));

    const tag = match[0];
    const tagMatch = /^<\/?\s*([a-zA-Z0-9]+)/.exec(tag);
    if (tagMatch) {
      const tagName = normalizeTagName(tagMatch[1]);
      if (ALLOWED_TAGS.has(tagName)) {
        const isClosing = /^<\s*\//.test(tag);
        if (VOID_TAGS.has(tagName)) {
          output += "<br>";
        } else {
          output += isClosing ? `</${tagName}>` : `<${tagName}>`;
        }
      }
    }
    lastIndex = index + tag.length;
  }

  output += escapeHtml(decodeEntities(input.slice(lastIndex)));
  return output.trim();
}

export function abstractHtmlToText(input: string): string {
  if (!input) return "";
  const withBreaks = input
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|li|ul|ol)\s*>/gi, "\n")
    .replace(/<\s*(p|ul|ol|li)(\s[^>]*)?>/gi, "\n");
  // Replace any remaining (inline) tags with a space so neighbouring words are
  // not glued together — e.g. "<strong>one</strong><strong>two</strong>" must
  // count as two words, not one, otherwise word limits can be bypassed.
  return decodeEntities(withBreaks.replace(TAG_PATTERN, " "))
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeAbstractContent(content: AbstractContent): AbstractContent {
  // Titles are plain-text headings, so strip all markup down to visible text
  // (this also removes any unsafe tags the body allowlist would otherwise miss).
  const title = abstractHtmlToText(content.title);
  if (content.mode === "FREE_TEXT") {
    return {
      ...content,
      title,
      body: sanitizeAbstractHtml(content.body),
    };
  }

  const sanitized = { ...content, title };
  for (const section of STRUCTURED_SECTIONS) {
    sanitized[section] = sanitizeAbstractHtml(content[section]);
  }
  return sanitized;
}

export function abstractContentFields(content: AbstractContent): Array<{
  name: string;
  value: string;
}> {
  const fields = [{ name: "title", value: content.title }];
  if (content.mode === "FREE_TEXT") {
    fields.push({ name: "body", value: content.body });
    return fields;
  }
  for (const section of STRUCTURED_SECTIONS) {
    fields.push({ name: section, value: content[section] });
  }
  return fields;
}

export { STRUCTURED_SECTIONS };
export type { AbstractContent };
