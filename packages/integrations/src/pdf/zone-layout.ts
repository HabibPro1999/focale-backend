// =============================================================================
// PDF ZONE LAYOUT
// Text zones drawn on a PDF page, shared by certificates and badges: the
// embedded fonts, auto-fit, truncation, alignment and color parsing. A zone is
// a box in percent of the page with a top-left origin.
// =============================================================================

import { type PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { dejaVuFontPath, embedFontFile } from "../pdf-fonts";
import { bidiTextWidth, pdfTextRuns } from "./bidi-text";
import { logger } from "../logger";
import { integrationsConfig } from "../config";

// color-name is a CommonJS package (no type decls). @app/integrations is
// type:commonjs, so the global require resolves it.
const cssColorNames = require("color-name") as Record<
  string,
  [number, number, number]
>;

export interface ZoneFonts {
  regularFont: PDFFont;
  boldFont: PDFFont;
}

/** A text zone's box (percent of the page, top-left origin) and style. */
export interface TextZoneLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  /** null = auto-fit. */
  fontSize: number | null;
  fontWeight: "normal" | "bold";
  color: string;
  textAlign: "left" | "center" | "right";
}

/** The zone fonts: CERTIFICATE_FONT_PATH / CERTIFICATE_BOLD_FONT_PATH, else DejaVu Sans. */
export async function embedZoneFonts(pdfDoc: PDFDocument): Promise<ZoneFonts> {
  const fonts = integrationsConfig().certificates;
  const regularFontPath = fonts.fontPath ?? dejaVuFontPath("DejaVuSans.ttf");
  const boldFontPath = fonts.boldFontPath ?? dejaVuFontPath("DejaVuSans-Bold.ttf");

  const [regularFont, boldFont] = await Promise.all([
    embedFontFile(pdfDoc, regularFontPath),
    embedFontFile(pdfDoc, boldFontPath),
  ]);

  return { regularFont, boldFont };
}

function findFitFontSize(
  font: PDFFont,
  text: string,
  maxWidth: number,
  maxHeight: number,
  maxFontSize = 72,
  minFontSize = 4,
): number {
  if (maxWidth <= 0 || maxHeight <= 0) return minFontSize;

  let lo = minFontSize;
  let hi = maxFontSize;
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    const width = bidiTextWidth(font, text, mid);
    const height = font.heightAtSize(mid);
    if (width <= maxWidth && height <= maxHeight) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.floor(lo);
}

export function truncateTextToWidth(
  font: PDFFont,
  text: string,
  fontSize: number,
  maxWidth: number,
): string {
  if (bidiTextWidth(font, text, fontSize) <= maxWidth) return text;

  const ellipsis = "...";
  if (bidiTextWidth(font, ellipsis, fontSize) > maxWidth) return "";

  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join("")}${ellipsis}`;
    if (bidiTextWidth(font, candidate, fontSize) <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return `${chars.slice(0, lo).join("")}${ellipsis}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getVerticalTextMetrics(
  font: PDFFont,
  size: number,
): { height: number; baselineOffset: number } {
  const fullHeight = font.heightAtSize(size, { descender: true });
  const ascenderHeight = font.heightAtSize(size, { descender: false });

  return {
    height: fullHeight,
    baselineOffset: Math.max(0, fullHeight - ascenderHeight),
  };
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const color = hex.trim().toLowerCase();

  const shortHexMatch = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(color);
  if (shortHexMatch) {
    return {
      r: parseInt(shortHexMatch[1] + shortHexMatch[1], 16) / 255,
      g: parseInt(shortHexMatch[2] + shortHexMatch[2], 16) / 255,
      b: parseInt(shortHexMatch[3] + shortHexMatch[3], 16) / 255,
    };
  }

  const longHexMatch = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  if (longHexMatch) {
    return {
      r: parseInt(longHexMatch[1], 16) / 255,
      g: parseInt(longHexMatch[2], 16) / 255,
      b: parseInt(longHexMatch[3], 16) / 255,
    };
  }

  const rgbMatch =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.exec(
      color,
    );
  if (rgbMatch) {
    const channels = rgbMatch
      .slice(1, 4)
      .map((channel) => clamp(Number(channel), 0, 255) / 255);
    return { r: channels[0], g: channels[1], b: channels[2] };
  }

  const named = cssColorNames[color];
  if (named) {
    return {
      r: named[0] / 255,
      g: named[1] / 255,
      b: named[2] / 255,
    };
  }

  logger.warn({ color: hex }, "Unsupported zone text color; using black");
  return { r: 0, g: 0, b: 0 };
}

function fitTextToZone(
  font: PDFFont,
  text: string,
  maxWidth: number,
  maxHeight: number,
  requestedFontSize: number | null,
): { text: string; fontSize: number } {
  const maxFontSize = requestedFontSize ?? 72;
  const fontSize = findFitFontSize(font, text, maxWidth, maxHeight, maxFontSize);
  const fittedText = truncateTextToWidth(font, text, fontSize, maxWidth);

  return {
    text: fittedText,
    fontSize,
  };
}

/**
 * Draw `value` in `zone` on a page of `pageWidth` x `pageHeight` points:
 * fitted (or at the zone's size, shrunk to fit), truncated with an ellipsis,
 * aligned, vertically centred. An empty value (or "—") draws nothing.
 */
export function drawTextZone(
  page: PDFPage,
  zone: TextZoneLayout,
  value: string,
  fonts: ZoneFonts,
  pageWidth: number,
  pageHeight: number,
): void {
  if (!value || value === "—") return;

  const font = zone.fontWeight === "bold" ? fonts.boldFont : fonts.regularFont;

  const zoneX = (zone.x / 100) * pageWidth;
  const zoneY = (zone.y / 100) * pageHeight;
  const zoneW = (zone.width / 100) * pageWidth;
  const zoneH = (zone.height / 100) * pageHeight;

  const { text, fontSize } = fitTextToZone(font, value, zoneW, zoneH, zone.fontSize);
  if (!text) return;

  // Mixed Latin/Arabic text is drawn run by run in visual order (./bidi-text).
  const runs = pdfTextRuns(text);
  const runWidths = runs.map((run) => font.widthOfTextAtSize(run, fontSize));
  const textWidth = runWidths.reduce((sum, width) => sum + width, 0);
  const { height: textHeight, baselineOffset } = getVerticalTextMetrics(font, fontSize);

  let textX = zoneX;
  if (zone.textAlign === "center") {
    textX = zoneX + (zoneW - textWidth) / 2;
  } else if (zone.textAlign === "right") {
    textX = zoneX + zoneW - textWidth;
  }
  textX = clamp(textX, zoneX, zoneX + Math.max(0, zoneW - textWidth));

  // PDF origin is bottom-left; zone Y is from top
  const zoneBottom = pageHeight - zoneY - zoneH;
  const textY = clamp(
    zoneBottom + (zoneH - textHeight) / 2 + baselineOffset,
    zoneBottom,
    zoneBottom + Math.max(0, zoneH - textHeight) + baselineOffset,
  );

  const { r, g, b } = hexToRgb(zone.color);

  let runX = textX;
  for (const [index, run] of runs.entries()) {
    page.drawText(run, {
      x: runX,
      y: textY,
      size: fontSize,
      font,
      color: rgb(r, g, b),
    });
    runX += runWidths[index]!;
  }
}
