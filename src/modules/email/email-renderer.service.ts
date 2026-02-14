// =============================================================================
// EMAIL RENDERER SERVICE
// Converts Tiptap JSON documents to MJML, then compiles to responsive HTML
// =============================================================================

import mjml2html from "mjml";
import { sanitizeUrl, sanitizeForHtml } from "./email-variable.service.js";
import type {
  TiptapDocument,
  TiptapNode,
  TiptapMark,
  MjmlCompilationResult,
} from "./email.types.js";

// =============================================================================
// CSS VALUE VALIDATORS (XSS Prevention)
// =============================================================================

const ALLOWED_COLORS =
  /^#[0-9a-fA-F]{3,8}$|^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$|^[a-zA-Z]{1,20}$/;
const ALLOWED_FONT_SIZES = /^\d{1,3}(px|em|rem|pt|%)$/;
const ALLOWED_FONT_FAMILIES = /^[a-zA-Z\s,'-]{1,200}$/;

function isValidCssColor(value: string): boolean {
  return ALLOWED_COLORS.test(value.trim());
}

function isValidFontSize(value: string): boolean {
  return ALLOWED_FONT_SIZES.test(value.trim());
}

function isValidFontFamily(value: string): boolean {
  return ALLOWED_FONT_FAMILIES.test(value.trim());
}

// =============================================================================
// MAIN EXPORTS
// =============================================================================

/**
 * Converts a Tiptap JSON document to MJML markup
 * Wraps content in a full MJML structure with header, body, and footer
 */
export function renderTemplateToMjml(document: TiptapDocument): string {
  const bodyContent = document.content
    .map((node) => renderNode(node))
    .join("\n");

  return `
<mjml>
  <mj-head>
    <mj-raw>
      <meta name="color-scheme" content="light dark">
      <meta name="supported-color-schemes" content="light dark">
    </mj-raw>
    <mj-attributes>
      <mj-all font-family="Arial, sans-serif" />
      <mj-text font-size="14px" line-height="1.6" color="#333333" />
      <mj-button background-color="#4F46E5" color="#ffffff" border-radius="6px" inner-padding="10px 25px" />
    </mj-attributes>
    <mj-style>
      .variable {
        background-color: #E0E7FF;
        padding: 2px 4px;
        border-radius: 4px;
        color: #4338CA;
      }
    </mj-style>
    <mj-style inline="inline">
      a {
        color: #4F46E5;
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
    </mj-style>
  </mj-head>
  <mj-body background-color="#f4f4f5">
    <!-- Header -->
    <mj-section background-color="#4F46E5" padding="20px">
      <mj-column>
        <mj-text align="center" color="#ffffff" font-size="24px" font-weight="bold">
          {{organizerName}}
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Main Content -->
    <mj-section background-color="#ffffff" padding="30px 20px">
      <mj-column>
        ${bodyContent}
      </mj-column>
    </mj-section>

    <!-- Footer -->
    <mj-section background-color="#f4f4f5" padding="20px">
      <mj-column>
        <mj-text align="center" font-size="12px" color="#6b7280">
          Powered by Focale agency
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `.trim();
}

/**
 * Compiles MJML markup to responsive HTML
 * Uses strict validation but filters out template variable warnings
 */
export function compileMjmlToHtml(mjml: string): MjmlCompilationResult {
  const result = mjml2html(mjml, {
    validationLevel: "strict",
    minify: false,
    beautify: false,
  });

  // Filter out errors that are just template variable placeholders (expected)
  const errors = (result.errors || []).filter((error) => {
    const msg = error.message || "";
    // Allow {{variable}} patterns which are intentional template placeholders
    return !msg.includes("{{") && !msg.includes("}}");
  });

  // If there are real MJML errors after filtering, throw an error
  if (errors.length > 0) {
    const errorMessages = errors
      .map((e) => e.message || e.formattedMessage)
      .join("; ");
    throw new Error(`MJML compilation failed: ${errorMessages}`);
  }

  return {
    html: result.html,
    errors: [],
  };
}

/**
 * Extracts plain text content from a Tiptap document
 * Preserves mention nodes as {{variable}} placeholders
 */
export function extractPlainText(document: TiptapDocument): string {
  return document.content
    .map((node) => extractTextFromNode(node))
    .join("\n")
    .trim();
}

// =============================================================================
// NODE RENDERING
// =============================================================================

/**
 * Renders a Tiptap node to MJML markup
 */
export function renderNode(node: TiptapNode): string {
  switch (node.type) {
    case "paragraph":
      return renderParagraph(node);
    case "heading":
      return renderHeading(node);
    case "bulletList":
      return renderBulletList(node);
    case "orderedList":
      return renderOrderedList(node);
    case "listItem":
      return renderListItem(node);
    case "blockquote":
      return renderBlockquote(node);
    case "horizontalRule":
      return '<mj-divider border-color="#e5e7eb" border-width="1px" />';
    case "hardBreak":
      return "<br />";
    case "image":
      return renderImage(node);
    default:
      // For unknown nodes, try to render content
      if (node.content) {
        return node.content.map(renderNode).join("");
      }
      return "";
  }
}

/**
 * Link-type variable IDs that should render as buttons/links instead of plain text
 */
const LINK_VARIABLE_IDS = new Set([
  "registrationLink",
  "editRegistrationLink",
  "paymentLink",
]);

/**
 * Button labels for link-type variables
 */
const LINK_BUTTON_LABELS: Record<string, string> = {
  registrationLink: "View Registration",
  editRegistrationLink: "Edit Registration",
  paymentLink: "Upload Payment Receipt",
};

/**
 * Renders a paragraph node
 * Detects standalone link-type mentions and renders them as buttons
 */
function renderParagraph(node: TiptapNode): string {
  const nodes = node.content || [];
  const align = (node.attrs?.textAlign as string) || "left";

  // Check if this paragraph contains a single link-type mention (possibly with whitespace text)
  const nonEmptyNodes = nodes.filter(
    (n) => !(n.type === "text" && (!n.text || n.text.trim() === "")),
  );
  if (nonEmptyNodes.length === 1 && nonEmptyNodes[0].type === "mention") {
    const varId = (nonEmptyNodes[0].attrs?.id as string) || "";
    if (LINK_VARIABLE_IDS.has(varId)) {
      const label = LINK_BUTTON_LABELS[varId] || varId;
      return `<mj-button href="{{${varId}}}" align="${align}">${label}</mj-button>`;
    }
  }

  const content = renderInlineContent(nodes);

  // Extract styles from node attributes
  const attrs: string[] = [`align="${align}"`];
  if (node.attrs?.fontSize) attrs.push(`font-size="${node.attrs.fontSize}"`);
  if (node.attrs?.lineHeight)
    attrs.push(`line-height="${node.attrs.lineHeight}"`);

  // Empty paragraph becomes a spacer
  if (!content || content.trim() === "") {
    return "<mj-text>&nbsp;</mj-text>";
  }

  return `<mj-text ${attrs.join(" ")}>${content}</mj-text>`;
}

/**
 * Renders a heading node (h1-h6)
 */
function renderHeading(node: TiptapNode): string {
  const level = (node.attrs?.level as number) || 1;
  const content = renderInlineContent(node.content || []);
  const align = (node.attrs?.textAlign as string) || "left";

  const sizes: Record<number, string> = {
    1: "28px",
    2: "24px",
    3: "20px",
    4: "18px",
    5: "16px",
    6: "14px",
  };

  const lineHeights: Record<number, string> = {
    1: "1.3",
    2: "1.4",
    3: "1.4",
    4: "1.4",
    5: "1.5",
    6: "1.5",
  };

  const fontSize = sizes[level] || "14px";
  const lineHeight = lineHeights[level] || "1.4";

  return `<mj-text align="${align}" font-size="${fontSize}" font-weight="bold" line-height="${lineHeight}" padding-bottom="10px">${content}</mj-text>`;
}

/**
 * Renders a bullet list
 */
function renderBulletList(node: TiptapNode): string {
  const items = (node.content || [])
    .map((item) => {
      const itemContent = item.content?.[0]?.content || item.content || [];
      return `<li>${renderInlineContent(itemContent)}</li>`;
    })
    .join("\n");

  return `<mj-text><ul style="margin: 0; padding-left: 20px;">${items}</ul></mj-text>`;
}

/**
 * Renders an ordered list
 */
function renderOrderedList(node: TiptapNode): string {
  const items = (node.content || [])
    .map((item) => {
      const itemContent = item.content?.[0]?.content || item.content || [];
      return `<li>${renderInlineContent(itemContent)}</li>`;
    })
    .join("\n");

  return `<mj-text><ol style="margin: 0; padding-left: 20px;">${items}</ol></mj-text>`;
}

/**
 * Renders a list item (usually handled by parent list)
 */
function renderListItem(node: TiptapNode): string {
  return renderInlineContent(node.content?.[0]?.content || []);
}

/**
 * Renders a blockquote
 */
function renderBlockquote(node: TiptapNode): string {
  const content = (node.content || []).map(renderNode).join("");

  return `
    <mj-section padding="0">
      <mj-column border-left="4px solid #e5e7eb" padding-left="16px">
        ${content}
      </mj-column>
    </mj-section>
  `;
}

/**
 * Renders an image node
 */
function renderImage(node: TiptapNode): string {
  const src = escapeHtml(String(node.attrs?.src || ""));
  const alt = escapeHtml(String(node.attrs?.alt ?? ""));
  const width = String(node.attrs?.width || "600");

  if (!src) return "";

  return `<mj-image src="${src}" alt="${alt}" width="${width}" />`;
}

// =============================================================================
// INLINE CONTENT RENDERING
// =============================================================================

/**
 * Renders an array of inline nodes to HTML string
 */
export function renderInlineContent(nodes: TiptapNode[]): string {
  return nodes.map(renderInlineNode).join("");
}

/**
 * Renders a single inline node
 */
export function renderInlineNode(node: TiptapNode): string {
  if (node.type === "text") {
    let text = escapeHtml(node.text || "");

    // Apply marks (formatting)
    if (node.marks && node.marks.length > 0) {
      text = applyMarks(text, node.marks);
    }

    return text;
  }

  if (node.type === "mention") {
    // Variable placeholder - will be replaced at send time
    const varId = (node.attrs?.id as string) || "";

    // Link-type variables render as clickable links when inline
    if (LINK_VARIABLE_IDS.has(varId)) {
      const label = LINK_BUTTON_LABELS[varId] || varId;
      return `<a href="{{${varId}}}" target="_blank" style="color: #4F46E5;">${label}</a>`;
    }

    return `{{${varId}}}`;
  }

  if (node.type === "hardBreak") {
    return "<br />";
  }

  // Recurse for other inline nodes
  if (node.content) {
    return renderInlineContent(node.content);
  }

  return "";
}

/**
 * Applies formatting marks to text
 */
export function applyMarks(text: string, marks: TiptapMark[]): string {
  let result = text;

  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        result = `<strong>${result}</strong>`;
        break;
      case "italic":
        result = `<em>${result}</em>`;
        break;
      case "underline":
        result = `<u>${result}</u>`;
        break;
      case "strike":
        result = `<s>${result}</s>`;
        break;
      case "code":
        result = `<code style="background-color: #f3f4f6; padding: 2px 4px; border-radius: 4px; font-family: monospace;">${result}</code>`;
        break;
      case "link": {
        const href = escapeHtml(sanitizeUrl(String(mark.attrs?.href || "#")));
        const target = (mark.attrs?.target as string) || "_blank";
        result = `<a href="${href}" target="${target}" style="color: #4F46E5;">${result}</a>`;
        break;
      }
      case "textStyle": {
        const styles: string[] = [];
        const color = String(mark.attrs?.color || "");
        const bgColor = String(mark.attrs?.backgroundColor || "");
        const fontSize = String(mark.attrs?.fontSize || "");
        const fontFamily = String(mark.attrs?.fontFamily || "");

        if (color && isValidCssColor(color))
          styles.push(`color: ${escapeHtml(color)}`);
        if (bgColor && isValidCssColor(bgColor))
          styles.push(`background-color: ${escapeHtml(bgColor)}`);
        if (fontSize && isValidFontSize(fontSize))
          styles.push(`font-size: ${fontSize}`);
        if (fontFamily && isValidFontFamily(fontFamily))
          styles.push(`font-family: ${escapeHtml(fontFamily)}`);

        if (styles.length > 0) {
          result = `<span style="${styles.join("; ")}">${result}</span>`;
        }
        break;
      }
    }
  }

  return result;
}

// =============================================================================
// PLAIN TEXT EXTRACTION
// =============================================================================

/**
 * Recursively extracts text from a Tiptap node
 */
function extractTextFromNode(node: TiptapNode, parentType?: string): string {
  // Direct text content
  if (node.text) {
    return node.text;
  }

  // Mention nodes become {{variable}}
  if (node.type === "mention") {
    const varId = (node.attrs?.id as string) || "";
    return `{{${varId}}}`;
  }

  // Hard breaks become newlines
  if (node.type === "hardBreak") {
    return "\n";
  }

  // Horizontal rules become separator
  if (node.type === "horizontalRule") {
    return "\n---\n";
  }

  // Recursively extract from children
  if (!node.content) {
    return "";
  }

  const childText = node.content
    .map((child) => extractTextFromNode(child, node.type))
    .join("");

  // Add appropriate line breaks based on node type
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "blockquote":
      return childText + "\n";
    case "bulletList":
    case "orderedList":
      return childText + "\n";
    case "listItem":
      return (
        (parentType === "orderedList" ? "1. " : "- ") + childText.trim() + "\n"
      );
    default:
      return childText;
  }
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Escapes HTML special characters to prevent XSS
 * Delegates to sanitizeForHtml from variable service to avoid duplication
 */
export function escapeHtml(text: string): string {
  return sanitizeForHtml(text);
}
