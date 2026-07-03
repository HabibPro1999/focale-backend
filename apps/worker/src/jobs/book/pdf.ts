// Abstract Book PDF generation — ported verbatim (semantics) from legacy
// src/modules/abstracts/abstracts.book.service.ts. Two-column A4 layout using
// pdf-lib StandardFonts (WinAnsi/CP1252). toWinAnsiSafe replaces characters the
// built-in fonts cannot encode with "?" so a single exotic glyph never aborts
// the whole book. (fontkit/DejaVu are used by certificates, NOT the book.)

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type { AbstractBookData, AbstractBookConfig } from "@app/db";
import { abstractHtmlToText } from "@app/shared";

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

function getContentTitle(content: unknown): string {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const title = (content as Record<string, unknown>).title;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return "Untitled abstract";
}

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

function withAffiliation(name: string, affiliation: string | undefined): string {
  const trimmed = affiliation?.trim();
  return trimmed ? `${name} (${trimmed})` : name;
}

function getAuthorLine(abstract: BookAbstract): string {
  const primaryName =
    `${abstract.authorFirstName} ${abstract.authorLastName}`.trim();
  const names = [
    withAffiliation(primaryName, abstract.authorAffiliation ?? undefined),
  ];
  if (Array.isArray(abstract.coAuthors)) {
    for (const coAuthor of abstract.coAuthors) {
      if (!coAuthor || typeof coAuthor !== "object" || Array.isArray(coAuthor)) {
        continue;
      }
      const record = coAuthor as Record<string, unknown>;
      const firstName =
        typeof record.firstName === "string" ? record.firstName : "";
      const lastName =
        typeof record.lastName === "string" ? record.lastName : "";
      const affiliation =
        typeof record.affiliation === "string" ? record.affiliation : undefined;
      const fullName = `${firstName} ${lastName}`.trim();
      if (fullName) names.push(withAffiliation(fullName, affiliation));
    }
  }
  return names.filter(Boolean).join(", ");
}

function typeLabel(value: string | null): string {
  if (value === "CONFERENCE") return "Conférence";
  if (value === "ORAL_COMMUNICATION") return "Communication orale";
  if (value === "POSTER") return "Communication affichée";
  return "—";
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

function fontForFamily(family: string): {
  regular: StandardFonts;
  bold: StandardFonts;
} {
  const normalized = family.toLocaleLowerCase();
  if (normalized.includes("times")) {
    return { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold };
  }
  if (normalized.includes("courier")) {
    return { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold };
  }
  return { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold };
}

// The extra Unicode code points CP1252 maps in its 0x80–0x9F range; everything
// in Latin-1 (≤ 0xFF) is also directly encodable by the WinAnsi standard fonts.
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function toWinAnsiSafe(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code === 0x09 ||
      code === 0x0a ||
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      WINANSI_EXTRA.has(code)
    ) {
      result += char;
    } else {
      result += "?";
    }
  }
  return result;
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const paragraphs = toWinAnsiSafe(text).split(/\r?\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

type TextOptions = {
  bold?: boolean;
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
    private readonly regularFont: PDFFont,
    private readonly boldFont: PDFFont,
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

  text(text: string, options?: TextOptions) {
    const size = options?.size ?? this.fontSize;
    const font = options?.bold ? this.boldFont : this.regularFont;
    const lineHeight = Math.max(size * 1.25, this.lineHeight);
    const lines = wrapText(text, font, size, COLUMN_WIDTH);
    this.ensure(Math.max(lineHeight, lines.length * lineHeight));
    for (const line of lines) {
      if (this.y - lineHeight < MARGIN) this.nextColumnOrPage();
      if (line) {
        this.page.drawText(line, {
          x: this.columnX(),
          y: this.y,
          size,
          font,
          color: options?.color ?? rgb(0.1, 0.1, 0.1),
        });
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
    const lines = wrapText(text, font, size, FULL_WIDTH);
    this.ensure(Math.max(lineHeight, lines.length * lineHeight));
    for (const line of lines) {
      if (this.y - lineHeight < MARGIN) this.addPage();
      if (line) {
        this.page.drawText(line, {
          x: MARGIN,
          y: this.y,
          size,
          font,
          color: options?.color ?? rgb(0.1, 0.1, 0.1),
        });
      }
      this.y -= lineHeight;
    }
    this.y -= options?.gapAfter ?? 0;
  }
}

export async function generateAbstractBookPdf(
  data: AbstractBookData,
): Promise<{ buffer: Buffer; includedCount: number }> {
  const { config } = data;
  const abstracts = sortAbstracts(data.abstracts, config.bookOrder);

  const pdfDoc = await PDFDocument.create();
  const fontChoice = fontForFamily(config.bookFontFamily);
  const regularFont = await pdfDoc.embedFont(fontChoice.regular);
  const boldFont = await pdfDoc.embedFont(fontChoice.bold);
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
  abstracts.forEach((abstract, index) => {
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
    writer.text(`${abstract.code ?? "No code"} ${getContentTitle(abstract.content)}`, {
      bold: true,
      size: config.bookFontSize + 2,
      gapAfter: 6,
    });
    if (config.bookIncludeAuthorNames) {
      writer.text(getAuthorLine(abstract), { bold: true, gapAfter: 4 });
    }
    writer.text(`Correspondence: ${abstract.authorEmail}`, {
      size: Math.max(8, config.bookFontSize - 1),
      color: rgb(0.35, 0.35, 0.35),
      gapAfter: 8,
    });

    for (const section of getContentSections(abstract.content)) {
      writer.text(section.label, { bold: true, gapAfter: 2 });
      writer.text(section.text, { gapAfter: 8 });
    }
  });

  const bytes = await pdfDoc.save();
  return { buffer: Buffer.from(bytes), includedCount: abstracts.length };
}
