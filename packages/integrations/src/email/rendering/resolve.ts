// =============================================================================
// RESOLVE VARIABLES IN TEMPLATE
// Fills a template's {{variables}} from an email context.
// =============================================================================

import { decodeEntities, escapeHtml } from "@app/shared";
import type { EmailContext } from "./types";

// Variables that hold server-built HTML (their user parts are escaped when they
// are built) — inserted as-is into HTML, converted to text in text mode.
const HTML_SAFE_VARIABLES = new Set(["sponsoredItems", "beneficiaryList"]);

export interface ResolveVariablesOptions {
  /**
   * `html` (default): values are HTML-escaped, for HTML bodies.
   * `text`: for subjects and plain-text bodies. Values are inserted unescaped
   * (so "Dupont & Fils" is not sent as "Dupont &amp; Fils"), server-built HTML
   * values become text, and CR/LF in values becomes a space (no header
   * injection through a subject).
   */
  mode?: "html" | "text";
}

export function resolveVariables(
  template: string,
  context: EmailContext | Record<string, unknown>,
  options: ResolveVariablesOptions = {},
): string {
  const mode = options.mode ?? "html";
  return template.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_match, varId) => {
    const value = (context as Record<string, unknown>)[varId];

    if (value !== undefined && value !== null && value !== "") {
      if (mode === "text") {
        const text = HTML_SAFE_VARIABLES.has(varId)
          ? serverHtmlToText(String(value))
          : String(value);
        return text.replace(/[\r\n]+/g, " ");
      }
      if (HTML_SAFE_VARIABLES.has(varId)) {
        return String(value);
      }
      return sanitizeForHtml(String(value));
    }

    return "";
  });
}

/** Server-built HTML list (`<div>• …</div>…`) → text, one item per line. */
function serverHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/\s*(div|p|li)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** An email's subject, HTML body and plain-text body. */
export interface EmailParts {
  subject: string;
  html: string;
  plain: string;
}

/**
 * Fill an email's parts from one context: the subject and the plain text in
 * text mode, the HTML body with its values escaped.
 */
export function resolveEmailParts(
  parts: EmailParts,
  context: EmailContext | Record<string, unknown>,
): EmailParts {
  return {
    subject: resolveVariables(parts.subject, context, { mode: "text" }),
    html: resolveVariables(parts.html, context),
    plain: resolveVariables(parts.plain, context, { mode: "text" }),
  };
}

// =============================================================================
// XSS SANITIZATION
// =============================================================================

export function sanitizeForHtml(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}
