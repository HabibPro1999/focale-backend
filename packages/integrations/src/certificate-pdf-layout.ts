// =============================================================================
// CERTIFICATE PDF LAYOUT
// One certificate page: the template's background image with its text zones
// drawn on it (fonts, fitting, alignment, colors). certificates-pdf.ts
// re-exports generateCertificatePdf.
// =============================================================================

import { PDFDocument, type PDFFont, rgb } from "pdf-lib";
import type { CertificateZone } from "@app/contracts";
import { extractStorageKeyFromUrl } from "./storage/index";
import { StorageObjectNotFoundError } from "./storage/storage.provider";
import { loadCertificateImage } from "./certificate-image-cache";
import { dejaVuFontPath, embedFontFile } from "./pdf-fonts";
import { logger } from "./logger";
import { integrationsConfig } from "./config";

// =============================================================================
// PDF GENERATION HELPERS
// =============================================================================

// color-name is a CommonJS package (no type decls). @app/integrations is
// type:commonjs, so the global require resolves it.
const cssColorNames = require("color-name") as Record<
  string,
  [number, number, number]
>;

async function embedCertificateFonts(
  pdfDoc: PDFDocument,
): Promise<{ regularFont: PDFFont; boldFont: PDFFont }> {
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
    const width = font.widthOfTextAtSize(text, mid);
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
  if (font.widthOfTextAtSize(text, fontSize) <= maxWidth) return text;

  const ellipsis = "...";
  if (font.widthOfTextAtSize(ellipsis, fontSize) > maxWidth) return "";

  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join("")}${ellipsis}`;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
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

  logger.warn(
    { color: hex },
    "Unsupported certificate text color; using black",
  );
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

// =============================================================================
// STORAGE (template background image)
// Bytes come through the process-wide certificate image cache (3.8).
// =============================================================================

/**
 * The background to embed: the render image (a flattened JPEG, 3.8) when the
 * template has one, else the original upload. A render image missing from
 * storage falls back to the original too.
 */
async function getTemplateImageBuffer(template: {
  id?: string;
  templateUrl: string;
  renderImageKey: string | null;
}): Promise<Buffer> {
  if (template.renderImageKey) {
    try {
      return await loadCertificateImage(template.renderImageKey);
    } catch (error) {
      if (!(error instanceof StorageObjectNotFoundError)) throw error;
      logger.warn(
        { templateId: template.id, key: template.renderImageKey },
        "Certificate render image missing from storage; using the original image",
      );
    }
  }

  // Template images are always full URLs; a bare key is not accepted.
  const key = extractStorageKeyFromUrl(template.templateUrl, { allowBareKey: false });
  if (!key) {
    throw new Error(
      "Certificate template image is not stored in a supported location",
    );
  }
  return loadCertificateImage(key);
}

// =============================================================================
// SINGLE PDF GENERATION
// =============================================================================

/**
 * One certificate PDF. The page is templateWidth x templateHeight points (the
 * original image's pixel size) and the background fills it, whichever image
 * is embedded, so zone positions never depend on the render image's size.
 */
export async function generateCertificatePdf(
  template: {
    id?: string;
    templateUrl: string;
    templateWidth: number;
    templateHeight: number;
    renderImageKey: string | null;
    zones: CertificateZone[];
  },
  resolvedValues: Record<string, string>,
): Promise<Buffer> {
  const imageBuffer = await getTemplateImageBuffer(template);

  const pdfDoc = await PDFDocument.create();

  // Detect format from magic bytes (a render image is always a JPEG).
  const isPng = imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50;
  const isJpg = imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8;

  let image;
  if (isPng) {
    image = await pdfDoc.embedPng(imageBuffer);
  } else if (isJpg) {
    image = await pdfDoc.embedJpg(imageBuffer);
  } else {
    throw new Error(
      "Unsupported image format. Only PNG and JPEG are supported.",
    );
  }

  const { templateWidth, templateHeight } = template;
  const page = pdfDoc.addPage([templateWidth, templateHeight]);

  page.drawImage(image, {
    x: 0,
    y: 0,
    width: templateWidth,
    height: templateHeight,
  });

  const { regularFont, boldFont } = await embedCertificateFonts(pdfDoc);

  for (const zone of template.zones) {
    const resolvedText = resolvedValues[zone.variable] || "";
    if (!resolvedText || resolvedText === "—") continue;

    const font = zone.fontWeight === "bold" ? boldFont : regularFont;

    const zoneX = (zone.x / 100) * templateWidth;
    const zoneY = (zone.y / 100) * templateHeight;
    const zoneW = (zone.width / 100) * templateWidth;
    const zoneH = (zone.height / 100) * templateHeight;

    const { text, fontSize } = fitTextToZone(
      font,
      resolvedText,
      zoneW,
      zoneH,
      zone.fontSize,
    );
    if (!text) continue;

    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const { height: textHeight, baselineOffset } = getVerticalTextMetrics(
      font,
      fontSize,
    );

    let textX = zoneX;
    if (zone.textAlign === "center") {
      textX = zoneX + (zoneW - textWidth) / 2;
    } else if (zone.textAlign === "right") {
      textX = zoneX + zoneW - textWidth;
    }
    textX = clamp(textX, zoneX, zoneX + Math.max(0, zoneW - textWidth));

    // PDF origin is bottom-left; zone Y is from top
    const zoneBottom = templateHeight - zoneY - zoneH;
    const textY = clamp(
      zoneBottom + (zoneH - textHeight) / 2 + baselineOffset,
      zoneBottom,
      zoneBottom + Math.max(0, zoneH - textHeight) + baselineOffset,
    );

    const { r, g, b } = hexToRgb(zone.color);

    page.drawText(text, {
      x: textX,
      y: textY,
      size: fontSize,
      font,
      color: rgb(r, g, b),
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
