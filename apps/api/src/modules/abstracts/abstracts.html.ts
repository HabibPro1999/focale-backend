import { escapeHtml, abstractHtmlToText, decodeEntities } from "@app/shared";

const ALLOWED_TAGS = new Set(["p", "br", "strong", "em", "u", "ul", "ol", "li"]);
const VOID_TAGS = new Set(["br"]);
// Only treat `<` as the start of a tag when it is immediately followed by a
// letter (optionally preceded by `/` for a closing tag). This mirrors the
// HTML5 rule and keeps prose such as "p < 0.05 and n > 30" as literal text
// instead of swallowing it as a bogus tag.
const TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/g;

export type AbstractContent =
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

export function sanitizeAbstractContent(
  content: AbstractContent,
): AbstractContent {
  // Titles are plain-text headings, so strip all markup down to visible text.
  const title = abstractHtmlToText(content.title);
  if (content.mode === "FREE_TEXT") {
    return { ...content, title, body: sanitizeAbstractHtml(content.body) };
  }

  const sanitized = { ...content, title };
  for (const section of STRUCTURED_SECTIONS) {
    sanitized[section] = sanitizeAbstractHtml(content[section]);
  }
  return sanitized;
}

export function abstractContentFields(
  content: AbstractContent,
): Array<{ name: string; value: string }> {
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

export { STRUCTURED_SECTIONS, abstractHtmlToText };
