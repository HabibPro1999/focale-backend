// =============================================================================
// BADGE PDF
// One registrant badge: a page of the template's size in millimetres, its
// optional background cover-fitted, its text zones (./pdf/zone-layout, as
// certificates) and the registration's check-in QR code drawn as one vector
// path, so it prints crisp at any size and scans like the emailed PNG.
// =============================================================================

import { PDFDocument, type PDFPage, rgb } from "pdf-lib";
import type { BadgeQrZone, BadgeZone } from "@app/contracts";
import { StorageObjectNotFoundError } from "../storage/storage.provider";
import { loadTemplateImage } from "../certificate-image-cache";
import { logger } from "../logger";
import { drawTextZone, embedZoneFonts } from "../pdf/zone-layout";
import {
  buildCheckinQrMatrix,
  CHECKIN_QR_OPTIONS,
  qrModuleRuns,
  type QrModuleRun,
} from "../email/attachments/registration-qr";

/** PDF points per millimetre (72 points per inch). */
export function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

/** What rendering a badge reads from its template. */
export interface BadgeTemplateData {
  id?: string;
  widthMm: number;
  heightMm: number;
  /** The background's flattened JPEG copy; null without a background. */
  renderImageKey: string | null;
  zones: readonly BadgeZone[];
}

/**
 * The text values of an email context (`fullName`, `form_<fieldId>`, ...).
 * Non-string entries (internal snapshot keys) are left out.
 */
export function badgeValuesFromContext(context: object): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(context) as [string, unknown][]) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

/** The background JPEG, or null (with a warning) when it is gone from storage. */
async function loadBackground(template: BadgeTemplateData): Promise<Buffer | null> {
  if (!template.renderImageKey) return null;
  try {
    return await loadTemplateImage(template.renderImageKey);
  } catch (error) {
    if (!(error instanceof StorageObjectNotFoundError)) throw error;
    logger.warn(
      { badgeTemplateId: template.id, key: template.renderImageKey },
      "Badge background missing from storage; rendering without it",
    );
    return null;
  }
}

/**
 * The dark modules as one SVG path in module units (y down): a closed
 * rectangle per horizontal run. One path is filled as one shape, so no
 * viewer draws hairlines between adjacent rows.
 */
function qrModulesPath(runs: readonly QrModuleRun[]): string {
  return runs.map(({ row, col, length }) => `M${col} ${row}h${length}v1h-${length}z`).join("");
}

/**
 * The check-in QR in `zone`: a square of min(width, height) points centred in
 * the zone, white including the quiet zone, the dark modules filled in black
 * as a single path.
 */
function drawQrZone(
  page: PDFPage,
  zone: BadgeQrZone,
  registrationId: string,
  pageWidth: number,
  pageHeight: number,
): void {
  const zoneX = (zone.x / 100) * pageWidth;
  const zoneY = (zone.y / 100) * pageHeight;
  const zoneW = (zone.width / 100) * pageWidth;
  const zoneH = (zone.height / 100) * pageHeight;
  const side = Math.min(zoneW, zoneH);
  if (side <= 0) return;

  const matrix = buildCheckinQrMatrix(registrationId);
  const quiet = CHECKIN_QR_OPTIONS.margin;
  const module = side / (matrix.size + 2 * quiet);
  const left = zoneX + (zoneW - side) / 2;
  const top = zoneY + (zoneH - side) / 2;

  // PDF origin is bottom-left; zone y is from the top. The path's origin is
  // the top-left of the first module, and drawSvgPath flips its y axis.
  page.drawRectangle({ x: left, y: pageHeight - top - side, width: side, height: side, color: rgb(1, 1, 1) });
  page.drawSvgPath(qrModulesPath(qrModuleRuns(matrix)), {
    x: left + quiet * module,
    y: pageHeight - top - quiet * module,
    scale: module,
    color: rgb(0, 0, 0),
  });
}

/**
 * The badge of `registrationId` as a one-page PDF. Text zones read `values`
 * by their variable id; a missing or empty value draws nothing.
 */
export async function generateBadgePdf(
  template: BadgeTemplateData,
  values: Readonly<Record<string, string>>,
  registrationId: string,
): Promise<Buffer> {
  const background = await loadBackground(template);

  const pdfDoc = await PDFDocument.create();
  const pageWidth = mmToPt(template.widthMm);
  const pageHeight = mmToPt(template.heightMm);
  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  if (background) {
    // Cover-fit: fill the page, keep the aspect ratio, centre the overflow
    // (the page box clips it).
    const image = await pdfDoc.embedJpg(background);
    const scale = Math.max(pageWidth / image.width, pageHeight / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, {
      x: (pageWidth - width) / 2,
      y: (pageHeight - height) / 2,
      width,
      height,
    });
  }

  const textZones = template.zones.filter((zone) => zone.kind === "text");
  if (textZones.length > 0) {
    const fonts = await embedZoneFonts(pdfDoc);
    for (const zone of textZones) {
      drawTextZone(page, zone, values[zone.variable] || "", fonts, pageWidth, pageHeight);
    }
  }

  for (const zone of template.zones) {
    if (zone.kind === "qr") drawQrZone(page, zone, registrationId, pageWidth, pageHeight);
  }

  return Buffer.from(await pdfDoc.save());
}
