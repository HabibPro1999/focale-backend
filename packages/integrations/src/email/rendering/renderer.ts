// =============================================================================
// EMAIL RENDERER
// Converts Tiptap JSON documents to MJML, then compiles to responsive HTML.
// Rendering is deterministic; MJML 5 compilation is asynchronous.
// =============================================================================

import mjml2html from "mjml";
import { escapeHtml } from "@app/shared";
import {
  DEFAULT_LANGUAGE,
  EmailFontSizeSchema,
  EmailLineHeightSchema,
  EmailTextAlignSchema,
  type LanguageCode,
  type TiptapDocument,
  type TiptapNode,
  type TiptapMark,
} from "@app/contracts";
import type { MjmlCompilationResult } from "./types";

// =============================================================================
// FOCALE EMAIL STYLE
// A fixed light email: paper background, a white card (header with an amber
// rule, then the body), and a "Powered by Focale" footer. Colors are the form
// app's tokens as hex; the text stays Arial, as most clients load no web font.
// =============================================================================

const COLORS = {
  paper: "#f9fafb",
  card: "#ffffff",
  line: "#e3e5ea",
  ink: "#1a1e25",
  text: "#2b2f38",
  muted: "#636978",
  amber: "#d49311",
  amberInk: "#8a6314",
} as const;

const FONT_FAMILY = "Arial, Helvetica, sans-serif";

/**
 * The Focale compass mark, hosted by the public form app (form/public). A PNG:
 * Gmail and other clients strip inline SVG.
 */
export const FOCALE_MARK_URL = "https://registration.focale.agency/logo-icon.png";

const POWERED_BY: Record<LanguageCode, string> = {
  fr: "Propulsé par",
  en: "Powered by",
  ar: "بدعم من",
};

/**
 * Text in a Unicode isolate (FSI…PDI), so a Latin event name and an Arabic
 * date keep their own order on one line whatever the email's direction.
 */
function isolate(text: string): string {
  return `&#8296;${text}&#8297;`;
}

const LINK_STYLE = `color: ${COLORS.amberInk}; text-decoration: underline;`;

/** What rendering needs to know about the template: its language. */
interface RenderContext {
  language: LanguageCode;
  /** Text alignment when a node sets none: the language's start side. */
  defaultAlign: "left" | "right";
  rtl: boolean;
}

function renderContext(language: LanguageCode): RenderContext {
  const rtl = language === "ar";
  return { language, rtl, defaultAlign: rtl ? "right" : "left" };
}

// =============================================================================
// MAIN EXPORTS
// =============================================================================

export interface RenderTemplateOptions {
  /**
   * The template's language (fr by default): button and link labels, the
   * footer, and the text direction (`ar` renders right to left).
   */
  language?: LanguageCode;
}

/**
 * Converts a Tiptap JSON document to MJML markup, wrapped in the shared layout
 * (header showing {{organizerName}} and "{{eventName}} · {{eventDateRange}}",
 * the content, and the footer).
 */
export function renderTemplateToMjml(
  document: TiptapDocument,
  options: RenderTemplateOptions = {},
): string {
  const language = options.language ?? DEFAULT_LANGUAGE;
  const ctx = renderContext(language);
  const bodyContent = document.content
    .map((node) => renderNode(node, ctx))
    .join("\n");

  return renderEmailLayout(bodyContent, { language });
}

export interface EmailLayoutOptions {
  /**
   * MJML text the caller has escaped, in place of the `{{organizerName}}`
   * line. A fixed header has no "{{eventName}} · {{eventDateRange}}" line
   * under it.
   */
  header?: string;
  /** The email's language (fr by default): footer text and direction. */
  language?: LanguageCode;
}

/**
 * The shared email layout every Focale email uses: a white card holding the
 * header and the content (`bodyContent`: MJML column children), then the
 * footer. Templates keep the `{{organizerName}}`, `{{eventName}}` and
 * `{{eventDateRange}}` placeholders, resolved at send time.
 */
export function renderEmailLayout(
  bodyContent: string,
  options: EmailLayoutOptions = {},
): string {
  const language = options.language ?? DEFAULT_LANGUAGE;
  const { rtl, defaultAlign: align } = renderContext(language);
  const header = options.header ?? "{{organizerName}}";
  const eventLine =
    options.header === undefined
      ? `
            <mj-text align="${align}" padding="2px 25px 0" font-size="13px" line-height="1.5" color="${COLORS.muted}">${isolate("{{eventName}}")} · ${isolate("{{eventDateRange}}")}</mj-text>`
      : "";
  return `
<mjml lang="${language}" dir="${rtl ? "rtl" : "ltr"}">
  <mj-head>
    <mj-raw>
      <meta name="color-scheme" content="light">
      <meta name="supported-color-schemes" content="light">
    </mj-raw>
    <mj-attributes>
      <mj-all font-family="${FONT_FAMILY}" />
      <mj-text font-size="14px" line-height="1.6" color="${COLORS.text}" />
      <mj-button background-color="${COLORS.amber}" color="${COLORS.ink}" font-weight="bold" border-radius="6px" inner-padding="10px 22px" />${
        rtl
          ? `
      <mj-wrapper direction="rtl" />
      <mj-section direction="rtl" />
      <mj-column direction="rtl" />`
          : ""
      }
    </mj-attributes>
    <mj-style inline="inline">
      a {
        color: ${COLORS.amberInk};
        text-decoration: underline;
      }
    </mj-style>
  </mj-head>
  <mj-body background-color="${COLORS.paper}">
    <mj-wrapper padding="24px 12px 0">
      <mj-section background-color="${COLORS.card}" border="1px solid ${COLORS.line}" border-radius="6px" padding="0">
        <mj-column>
          <!-- Header -->
          <mj-text align="${align}" padding="18px 25px 0" font-size="19px" font-weight="bold" line-height="1.3" color="${COLORS.ink}">
            ${header}
          </mj-text>${eventLine}
          <mj-divider border-color="${COLORS.amber}" border-width="3px" padding="14px 0 0" />

          <!-- Main Content -->
          <mj-spacer height="12px" />
          ${bodyContent}
          <mj-spacer height="12px" />
        </mj-column>
      </mj-section>
    </mj-wrapper>

    <!-- Footer -->
    <mj-section padding="14px 12px 24px">
      <mj-column>
        <mj-text align="center" font-size="12px" line-height="16px" color="${COLORS.muted}">
          ${POWERED_BY[language]}&nbsp;<img src="${FOCALE_MARK_URL}" width="16" height="16" alt="" style="display: inline-block; width: 16px; height: 16px; vertical-align: -3px; border: 0;" />&nbsp;<b style="color: ${COLORS.ink};">Focale</b>
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `.trim();
}

/**
 * Compiles MJML markup to responsive HTML. Uses strict validation but filters
 * out template-variable placeholder warnings ({{ }}). Any remaining real error
 * throws a plain Error (surfaces as an unhandled 500 at the call site).
 */
export async function compileMjmlToHtml(
  mjml: string,
): Promise<MjmlCompilationResult> {
  const result = await mjml2html(mjml, {
    validationLevel: "strict",
    minify: false,
    beautify: false,
    ignoreIncludes: true,
  });

  const errors = (result.errors || []).filter((error) => {
    const msg = error.message || "";
    return !msg.includes("{{") && !msg.includes("}}");
  });

  if (errors.length > 0) {
    const errorMessages = errors
      .map((e) => e.message || e.formattedMessage)
      .join("; ");
    throw new Error(`MJML compilation failed: ${errorMessages}`);
  }

  return {
    html: result.html,
  };
}

/** Extracts plain text from a Tiptap document; mentions become {{variable}}. */
export function extractPlainText(document: TiptapDocument): string {
  return document.content
    .map((node) => extractTextFromNode(node))
    .join("\n")
    .trim();
}

// =============================================================================
// NODE RENDERING
// =============================================================================

function renderNode(node: TiptapNode, ctx: RenderContext): string {
  switch (node.type) {
    case "paragraph":
      return renderParagraph(node, ctx);
    case "heading":
      return renderHeading(node, ctx);
    case "bulletList":
      return renderList(node, "ul", ctx);
    case "orderedList":
      return renderList(node, "ol", ctx);
    case "listItem":
      return renderListItem(node, ctx);
    case "blockquote":
      return renderBlockquote(node, ctx);
    case "horizontalRule":
      return `<mj-divider border-color="${COLORS.line}" border-width="1px" />`;
    case "hardBreak":
      return "<br />";
    case "image":
      return renderImage(node);
    default:
      if (node.content) {
        return node.content.map((child) => renderNode(child, ctx)).join("");
      }
      return "";
  }
}

const LINK_VARIABLE_IDS = new Set([
  "registrationLink",
  "editRegistrationLink",
  "paymentLink",
]);

// Labels of the link variables (buttons and inline links), baked in when the
// template is compiled.
const LINK_LABELS: Record<LanguageCode, Record<string, string>> = {
  fr: {
    registrationLink: "Voir l'inscription",
    editRegistrationLink: "Modifier l'inscription",
    paymentLink: "Envoyer le justificatif de paiement",
  },
  en: {
    registrationLink: "View registration",
    editRegistrationLink: "Edit registration",
    paymentLink: "Send proof of payment",
  },
  ar: {
    registrationLink: "عرض التسجيل",
    editRegistrationLink: "تعديل التسجيل",
    paymentLink: "إرسال إثبات الدفع",
  },
};

function linkLabel(varId: string, ctx: RenderContext): string {
  return LINK_LABELS[ctx.language][varId] || escapeHtml(varId);
}

function safeTextAlign(value: unknown, ctx: RenderContext): string {
  const parsed = EmailTextAlignSchema.safeParse(value);
  return parsed.success ? parsed.data : ctx.defaultAlign;
}

function safeFontSize(value: unknown): string | undefined {
  if (value == null) return undefined;
  const parsed = EmailFontSizeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function safeLineHeight(value: unknown): string | undefined {
  if (value == null) return undefined;
  const parsed = EmailLineHeightSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function renderParagraph(node: TiptapNode, ctx: RenderContext): string {
  const nodes = node.content || [];
  const align = safeTextAlign(node.attrs?.textAlign, ctx);

  const nonEmptyNodes = nodes.filter(
    (n) => !(n.type === "text" && (!n.text || n.text.trim() === "")),
  );
  if (nonEmptyNodes.length === 1 && nonEmptyNodes[0].type === "mention") {
    const varId = (nonEmptyNodes[0].attrs?.id as string) || "";
    if (LINK_VARIABLE_IDS.has(varId)) {
      return `<mj-button href="{{${escapeHtml(varId)}}}" align="${escapeHtml(align)}">${linkLabel(varId, ctx)}</mj-button>`;
    }
  }

  const content = renderInlineContent(nodes, ctx);

  const attrs: string[] = [`align="${escapeHtml(align)}"`];
  const fontSize = safeFontSize(node.attrs?.fontSize);
  const lineHeight = safeLineHeight(node.attrs?.lineHeight);
  if (fontSize) attrs.push(`font-size="${escapeHtml(fontSize)}"`);
  if (lineHeight) attrs.push(`line-height="${escapeHtml(lineHeight)}"`);

  if (!content || content.trim() === "") {
    return "<mj-text>&nbsp;</mj-text>";
  }

  return `<mj-text ${attrs.join(" ")}>${content}</mj-text>`;
}

function renderHeading(node: TiptapNode, ctx: RenderContext): string {
  const level = (node.attrs?.level as number) || 1;
  const content = renderInlineContent(node.content || [], ctx);
  const align = safeTextAlign(node.attrs?.textAlign, ctx);

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

  return `<mj-text align="${escapeHtml(align)}" font-size="${escapeHtml(fontSize)}" font-weight="bold" line-height="${escapeHtml(lineHeight)}" color="${COLORS.ink}" padding-bottom="10px">${content}</mj-text>`;
}

function renderList(
  node: TiptapNode,
  tag: "ul" | "ol",
  ctx: RenderContext,
): string {
  const items = (node.content || [])
    .map((item) => {
      const itemContent = item.content?.[0]?.content || item.content || [];
      return `<li>${renderInlineContent(itemContent, ctx)}</li>`;
    })
    .join("\n");

  const indent = ctx.rtl ? "padding-right" : "padding-left";
  const align = ctx.rtl ? ' align="right"' : "";
  return `<mj-text${align}><${tag} style="margin: 0; ${indent}: 20px;">${items}</${tag}></mj-text>`;
}

function renderListItem(node: TiptapNode, ctx: RenderContext): string {
  return renderInlineContent(node.content?.[0]?.content || [], ctx);
}

function renderBlockquote(node: TiptapNode, ctx: RenderContext): string {
  const content = (node.content || [])
    .map((child) => renderNode(child, ctx))
    .join("");
  const side = ctx.rtl ? "right" : "left";

  return `
    <mj-section padding="0">
      <mj-column border-${side}="4px solid ${COLORS.line}" padding-${side}="16px">
        ${content}
      </mj-column>
    </mj-section>
  `;
}

function renderImage(node: TiptapNode): string {
  const src = escapeHtml(String(node.attrs?.src || ""));
  const alt = escapeHtml(String(node.attrs?.alt ?? ""));
  const widthValue = String(node.attrs?.width ?? "600").trim();
  const widthMatch = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(widthValue);
  const width = widthMatch ? `${widthMatch[1]}px` : "600px";

  if (!src) return "";

  return `<mj-image src="${src}" alt="${alt}" width="${escapeHtml(width)}" />`;
}

// =============================================================================
// INLINE CONTENT RENDERING
// =============================================================================

function renderInlineContent(nodes: TiptapNode[], ctx: RenderContext): string {
  return nodes.map((node) => renderInlineNode(node, ctx)).join("");
}

function renderInlineNode(node: TiptapNode, ctx: RenderContext): string {
  if (node.type === "text") {
    let text = escapeHtml(node.text || "");

    if (node.marks && node.marks.length > 0) {
      text = applyMarks(text, node.marks);
    }

    return text;
  }

  if (node.type === "mention") {
    const varId = (node.attrs?.id as string) || "";

    if (LINK_VARIABLE_IDS.has(varId)) {
      return `<a href="{{${escapeHtml(varId)}}}" target="_blank" style="${LINK_STYLE}">${linkLabel(varId, ctx)}</a>`;
    }

    return `{{${escapeHtml(varId)}}}`;
  }

  if (node.type === "hardBreak") {
    return "<br />";
  }

  if (node.content) {
    return renderInlineContent(node.content, ctx);
  }

  return "";
}

function applyMarks(text: string, marks: TiptapMark[]): string {
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
        const href = escapeHtml(String(mark.attrs?.href || "#"));
        const target = escapeHtml(String(mark.attrs?.target || "_blank"));
        result = `<a href="${href}" target="${target}" style="${LINK_STYLE}">${result}</a>`;
        break;
      }
      case "textStyle": {
        const styles: string[] = [];
        if (mark.attrs?.color)
          styles.push(`color: ${escapeHtml(String(mark.attrs.color))}`);
        if (mark.attrs?.backgroundColor)
          styles.push(
            `background-color: ${escapeHtml(String(mark.attrs.backgroundColor))}`,
          );
        if (mark.attrs?.fontSize)
          styles.push(`font-size: ${escapeHtml(String(mark.attrs.fontSize))}`);
        if (mark.attrs?.fontFamily)
          styles.push(
            `font-family: ${escapeHtml(String(mark.attrs.fontFamily))}`,
          );
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

function extractTextFromNode(node: TiptapNode): string {
  if (node.text) {
    return node.text;
  }

  if (node.type === "mention") {
    const varId = (node.attrs?.id as string) || "";
    return `{{${varId}}}`;
  }

  if (node.type === "hardBreak") {
    return "\n";
  }

  if (node.type === "horizontalRule") {
    return "\n---\n";
  }

  if (!node.content) {
    return "";
  }

  const childText = node.content.map(extractTextFromNode).join("");

  switch (node.type) {
    case "paragraph":
    case "heading":
    case "blockquote":
      return childText + "\n";
    case "bulletList":
    case "orderedList":
      return childText + "\n";
    case "listItem":
      return "- " + childText.trim() + "\n";
    default:
      return childText;
  }
}
