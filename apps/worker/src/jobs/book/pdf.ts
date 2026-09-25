import { ABSTRACT_TYPE_LABELS_FR, type AbstractFinalType } from "@app/contracts";
import { getAbstractTitle, getAuthorLine } from "@app/shared";
// Abstract Book PDF generation — ported (semantics) from legacy
// src/modules/abstracts/abstracts.book.service.ts. Two-column A4 layout.
// Text is drawn with embedded, subset DejaVu fonts (shared with certificates
// and the networking PDFs), so Greek, math symbols and Arabic/Hebrew names
// print as written instead of "?". Right-to-left runs go through pdfTextRuns
// (bidi reordering; fontkit shapes Arabic).

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { AbstractBookData, AbstractBookConfig } from "@app/db";
import { abstractHtmlToText } from "@app/shared";
import {
  embedDejaVuFont,
  pdfTextRuns,
  type DejaVuFace,
} from "@app/integrations";

type BookAbstract = AbstractBookData["abstracts"][number];
type BookOrder = AbstractBookConfig["bookOrder"];

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 54;
const COLUMN_GAP = 18;
const COLUMN_WIDTH = (A4[0] - MARGIN * 2 - COLUMN_GAP) / 2;
const FULL_WIDTH = A4[0] - MARGIN * 2;

const FINAL_TYPE_SORT_ORDER: Record<string, number> = {
  CONFERENCE: 0,
  ORAL_COMMUNICATION: 1,
  POSTER: 2,
};

function getContentSections(
  content: unknown,
): Array<{ label: string; text: string }> {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return [];
  }
  const record = content as Record<string, unknown>;
  if (record.mode === "STRUCTURED") {
    return (
      [
        ["Introduction", record.introduction],
        ["Objective", record.objective],
        ["Methods", record.methods],
        ["Results", record.results],
        ["Conclusion", record.conclusion],
      ] as const
    )
      .map(([label, value]) => ({
        label: String(label),
        text: typeof value === "string" ? abstractHtmlToText(value) : "",
      }))
      .filter((section) => section.text.length > 0);
  }
  const body =
    typeof record.body === "string" ? abstractHtmlToText(record.body) : "";
  return body ? [{ label: "Abstract", text: body }] : [];
}

// H9: additional-fields answers (e.g. keywords) never made it into the book —
// the renderer only ever read `content`. additionalFieldsSchema/Data are raw
// jsonb (unknown shape), so this reads them defensively field-by-field: schema
// order drives iteration, so unanswered fields and stale/unknown data keys are
// silently skipped (never printed), never guessed at.
const NON_ANSWER_FIELD_TYPES = new Set(["heading", "paragraph", "file"]);

function additionalFieldLabel(id: string, label: unknown): string {
  return typeof label === "string" && label.length > 0 ? label : id;
}

function resolveOptionLabel(options: unknown, id: string): string {
  if (Array.isArray(options)) {
    for (const option of options) {
      if (
        option &&
        typeof option === "object" &&
        (option as Record<string, unknown>).id === id
      ) {
        const label = (option as Record<string, unknown>).label;
        return typeof label === "string" && label.trim() ? label.trim() : id;
      }
    }
  }
  return id;
}

function formatAdditionalFieldValue(
  type: string,
  options: unknown,
  value: unknown,
): string {
  const clean = (raw: string) => abstractHtmlToText(raw).trim();

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return clean(resolveOptionLabel(options, item));
        if (typeof item === "number") return String(item);
        if (typeof item === "boolean") return item ? "Yes" : "No";
        return "";
      })
      .filter((item) => item.length > 0)
      .join(", ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const resolved =
      type === "dropdown" || type === "radio"
        ? resolveOptionLabel(options, value)
        : value;
    return clean(resolved);
  }
  return "";
}

/**
 * Pure field-rendering core of H9: given the event's additionalFieldsSchema
 * and one abstract's additionalFieldsData, produce the labelled lines to
 * print after the content sections — schema field order, label from the
 * schema (falling back to id, mirroring form-data-validator's getFieldLabel),
 * value formatted per type. Unanswered fields and unknown data keys are
 * skipped silently; values are run through the same abstractHtmlToText used
 * for author/content text so no stray markup reaches the page.
 */
export function getAdditionalFieldLines(
  schema: unknown,
  data: unknown,
): Array<{ label: string; text: string }> {
  if (!Array.isArray(schema)) return [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;

  const lines: Array<{ label: string; text: string }> = [];
  for (const entry of schema) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const field = entry as Record<string, unknown>;
    const id = field.id;
    if (typeof id !== "string" || !id) continue;
    const type = typeof field.type === "string" ? field.type : "";
    if (NON_ANSWER_FIELD_TYPES.has(type)) continue;
    if (!(id in record)) continue; // unanswered — skip silently

    const text = formatAdditionalFieldValue(type, field.options, record[id]);
    if (!text) continue; // empty/missing value — skip silently

    lines.push({ label: additionalFieldLabel(id, field.label), text });
  }
  return lines;
}

function typeLabel(value: AbstractFinalType | null): string {
  return value ? ABSTRACT_TYPE_LABELS_FR[value] ?? "—" : "—";
}

function themeLabel(abstract: BookAbstract): string {
  return abstract.themes
    .map((link) => link.label)
    .filter(Boolean)
    .join(", ");
}

function sortAbstracts(
  abstracts: BookAbstract[],
  order: BookOrder,
): BookAbstract[] {
  const copy = [...abstracts];
  if (order === "BY_SUBMISSION_ORDER") {
    return copy.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  if (order === "BY_THEME") {
    return copy.sort((a, b) => {
      const themeA = a.themes[0]?.sortOrder ?? 0;
      const themeB = b.themes[0]?.sortOrder ?? 0;
      if (themeA !== themeB) return themeA - themeB;
      const typeA = a.finalType ? FINAL_TYPE_SORT_ORDER[a.finalType] ?? 99 : 99;
      const typeB = b.finalType ? FINAL_TYPE_SORT_ORDER[b.finalType] ?? 99 : 99;
      if (typeA !== typeB) return typeA - typeB;
      return (a.codeNumber ?? 0) - (b.codeNumber ?? 0);
    });
  }
  return copy.sort((a, b) => (a.codeNumber ?? 0) - (b.codeNumber ?? 0));
}

// `bookFontFamily` keeps its meaning: Times → serif, Courier → monospace,
// anything else → sans. DejaVu Sans is also the fallback for text the chosen
// face lacks (DejaVu Serif has no Arabic or Hebrew glyphs).
function facesForFamily(family: string): { regular: DejaVuFace; bold: DejaVuFace } {
  const normalized = family.toLocaleLowerCase();
  if (normalized.includes("times")) {
    return { regular: "DejaVuSerif.ttf", bold: "DejaVuSerif-Bold.ttf" };
  }
  if (normalized.includes("courier")) {
    return { regular: "DejaVuSansMono.ttf", bold: "DejaVuSansMono-Bold.ttf" };
  }
  return { regular: "DejaVuSans.ttf", bold: "DejaVuSans-Bold.ttf" };
}

/** A face plus the fallback used for text it has no glyphs for. */
class BookFont {
  private readonly glyphs: Set<number>;

  constructor(
    private readonly primary: PDFFont,
    private readonly fallback: PDFFont,
  ) {
    this.glyphs = new Set(primary.getCharacterSet());
  }

  /** The font to draw `text` with: the chosen face if it covers every character. */
  fontFor(text: string): PDFFont {
    if (this.primary === this.fallback) return this.primary;
    for (const char of text) {
      if (!this.glyphs.has(char.codePointAt(0)!)) return this.fallback;
    }
    return this.primary;
  }

  /** Visual runs of one line, each with the font that draws it. */
  runs(
    line: string,
    size: number,
    direction: "ltr" | "rtl" | "auto" = "auto",
  ): Array<{ text: string; font: PDFFont; width: number }> {
    return pdfTextRuns(line, direction).map((text) => {
      const font = this.fontFor(text);
      return { text, font, width: font.widthOfTextAtSize(text, size) };
    });
  }

  width(text: string, size: number): number {
    return this.runs(text, size).reduce((sum, run) => sum + run.width, 0);
  }
}

const RTL_CHARACTER = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const LETTER = /\p{L}/u;

/**
 * Paragraph direction: `auto` follows its first letter (Unicode bidi rule P2),
 * so an Arabic title or abstract reads right-to-left and is right-aligned.
 * Lists that mix names from several scripts (the author line) pass `ltr`: the
 * book's own direction, with each Arabic/Hebrew name still drawn right-to-left.
 */
function paragraphDirection(
  text: string,
  base: "auto" | "ltr",
): "ltr" | "rtl" {
  if (base === "ltr") return "ltr";
  const first = LETTER.exec(text)?.[0];
  return first && RTL_CHARACTER.test(first) ? "rtl" : "ltr";
}

function wrapText(
  text: string,
  font: BookFont,
  size: number,
  maxWidth: number,
  base: "auto" | "ltr",
): Array<{ text: string; direction: "ltr" | "rtl" }> {
  const lines: Array<{ text: string; direction: "ltr" | "rtl" }> = [];
  const spaceWidth = font.width(" ", size);
  for (const paragraph of text.split(/\r?\n/)) {
    const direction = paragraphDirection(paragraph, base);
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push({ text: "", direction });
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const word of words) {
      const wordWidth = font.width(word, size);
      const candidateWidth = current ? currentWidth + spaceWidth + wordWidth : wordWidth;
      if (candidateWidth <= maxWidth) {
        current = current ? `${current} ${word}` : word;
        currentWidth = candidateWidth;
      } else {
        if (current) lines.push({ text: current, direction });
        current = word;
        currentWidth = wordWidth;
      }
    }
    if (current) lines.push({ text: current, direction });
  }
  return lines;
}

type TextOptions = {
  bold?: boolean;
  /** Paragraph direction; `auto` (default) follows the first letter. */
  direction?: "auto" | "ltr";
  size?: number;
  color?: ReturnType<typeof rgb>;
  gapAfter?: number;
};

class PdfWriter {
  private page: PDFPage;
  private y: number;
  private column = 0;

  constructor(
    private readonly pdfDoc: PDFDocument,
    private readonly regularFont: BookFont,
    private readonly boldFont: BookFont,
    private readonly fontSize: number,
    private readonly lineHeight: number,
  ) {
    this.page = pdfDoc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  addPage() {
    this.page = this.pdfDoc.addPage(A4);
    this.y = A4[1] - MARGIN;
    this.column = 0;
  }

  private columnX() {
    return MARGIN + this.column * (COLUMN_WIDTH + COLUMN_GAP);
  }

  private nextColumnOrPage() {
    if (this.column === 0) {
      this.column = 1;
      this.y = A4[1] - MARGIN;
    } else {
      this.addPage();
    }
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.nextColumnOrPage();
  }

  move(delta: number) {
    this.y -= delta;
  }

  /** One wrapped line; right-to-left paragraphs are right-aligned. */
  private drawLine(
    line: { text: string; direction: "ltr" | "rtl" },
    x: number,
    width: number,
    size: number,
    font: BookFont,
    color: ReturnType<typeof rgb>,
  ) {
    const runs = font.runs(line.text, size, line.direction);
    const lineWidth = runs.reduce((sum, run) => sum + run.width, 0);
    let runX = line.direction === "rtl" ? x + Math.max(0, width - lineWidth) : x;
    for (const run of runs) {
      this.page.drawText(run.text, { x: runX, y: this.y, size, font: run.font, color });
      runX += run.width;
    }
  }

  text(text: string, options?: TextOptions) {
    const size = options?.size ?? this.fontSize;
    const font = options?.bold ? this.boldFont : this.regularFont;
    const lineHeight = Math.max(size * 1.25, this.lineHeight);
    const lines = wrapText(text, font, size, COLUMN_WIDTH, options?.direction ?? "auto");
    this.ensure(Math.max(lineHeight, lines.length * lineHeight));
    for (const line of lines) {
      if (this.y - lineHeight < MARGIN) this.nextColumnOrPage();
      if (line.text) {
        this.drawLine(
          line,
          this.columnX(),
          COLUMN_WIDTH,
          size,
          font,
          options?.color ?? rgb(0.1, 0.1, 0.1),
        );
      }
      this.y -= lineHeight;
    }
    this.y -= options?.gapAfter ?? 0;
  }

  fullWidthText(text: string, options?: TextOptions) {
    if (this.column !== 0) this.addPage();
    const size = options?.size ?? this.fontSize;
    const font = options?.bold ? this.boldFont : this.regularFont;
    const lineHeight = Math.max(size * 1.25, this.lineHeight);
    const lines = wrapText(text, font, size, FULL_WIDTH, options?.direction ?? "auto");
    this.ensure(Math.max(lineHeight, lines.length * lineHeight));
    for (const line of lines) {
      if (this.y - lineHeight < MARGIN) this.addPage();
      if (line.text) {
        this.drawLine(
          line,
          MARGIN,
          FULL_WIDTH,
          size,
          font,
          options?.color ?? rgb(0.1, 0.1, 0.1),
        );
      }
      this.y -= lineHeight;
    }
    this.y -= options?.gapAfter ?? 0;
  }
}

/** Abstracts laid out between two yields to the event loop. */
const ABSTRACTS_PER_YIELD = 20;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Render the book. The layout yields to the event loop every few abstracts, so
 * the job's lease heartbeat keeps running during a long render, and stops
 * there once `signal` aborts (lost lease, timeout or shutdown).
 */
export async function generateAbstractBookPdf(
  data: AbstractBookData,
  options: { signal?: AbortSignal } = {},
): Promise<{ buffer: Buffer; includedCount: number }> {
  const { signal } = options;
  const { config } = data;
  const abstracts = sortAbstracts(data.abstracts, config.bookOrder);

  const pdfDoc = await PDFDocument.create();
  const faces = facesForFamily(config.bookFontFamily);
  // Each face is embedded once (the sans family is its own fallback).
  const embedded = new Map<DejaVuFace, Promise<PDFFont>>();
  const embed = (face: DejaVuFace): Promise<PDFFont> => {
    let font = embedded.get(face);
    if (!font) {
      font = embedDejaVuFont(pdfDoc, face);
      embedded.set(face, font);
    }
    return font;
  };
  const regularFont = new BookFont(
    await embed(faces.regular),
    await embed("DejaVuSans.ttf"),
  );
  const boldFont = new BookFont(
    await embed(faces.bold),
    await embed("DejaVuSans-Bold.ttf"),
  );
  const writer = new PdfWriter(
    pdfDoc,
    regularFont,
    boldFont,
    config.bookFontSize,
    config.bookFontSize * config.bookLineSpacing,
  );

  writer.fullWidthText(data.eventName, { bold: true, size: 22, gapAfter: 8 });
  writer.fullWidthText("Abstract Book", {
    bold: true,
    size: 16,
    gapAfter: 20,
    color: rgb(0.25, 0.25, 0.25),
  });

  if (abstracts.length === 0) {
    writer.text("No accepted abstracts are available for this book.", {
      gapAfter: 10,
    });
  }

  let currentGroup = "";
  for (const [index, abstract] of abstracts.entries()) {
    if (index % ABSTRACTS_PER_YIELD === 0) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    if (index > 0) writer.move(8);
    const group = `${themeLabel(abstract) || "No theme"} · ${typeLabel(abstract.finalType)}`;
    if (config.bookOrder === "BY_THEME" && group !== currentGroup) {
      currentGroup = group;
      writer.text(group, {
        bold: true,
        size: Math.max(9, config.bookFontSize + 1),
        color: rgb(0.18, 0.18, 0.18),
        gapAfter: 6,
      });
    }
    writer.ensure(120);
    writer.text(`${abstract.code ?? "No code"} ${getAbstractTitle(abstract.content)}`, {
      bold: true,
      size: config.bookFontSize + 2,
      gapAfter: 6,
    });
    if (config.bookIncludeAuthorNames) {
      writer.text(getAuthorLine(abstract), {
        bold: true,
        gapAfter: 4,
        direction: "ltr",
      });
    }
    writer.text(`Correspondence: ${abstract.authorEmail}`, {
      direction: "ltr",
      size: Math.max(8, config.bookFontSize - 1),
      color: rgb(0.35, 0.35, 0.35),
      gapAfter: 8,
    });

    for (const section of getContentSections(abstract.content)) {
      writer.text(section.label, { bold: true, gapAfter: 2 });
      writer.text(section.text, { gapAfter: 8 });
    }

    for (const field of getAdditionalFieldLines(
      config.additionalFieldsSchema,
      abstract.additionalFieldsData,
    )) {
      writer.text(field.label, { bold: true, gapAfter: 2 });
      writer.text(field.text, { gapAfter: 8 });
    }
  }

  await yieldToEventLoop();
  signal?.throwIfAborted();
  // save() yields between object batches on its own.
  const bytes = await pdfDoc.save();
  return { buffer: Buffer.from(bytes), includedCount: abstracts.length };
}
