// =============================================================================
// CERTIFICATE PDF LAYOUT
// One certificate page: the template's background image with its text zones
// drawn on it (fonts, fitting, alignment, colors: ./pdf/zone-layout).
// certificates-pdf.ts re-exports generateCertificatePdf.
// =============================================================================

import { PDFDocument } from "pdf-lib";
import type { CertificateZone } from "@app/contracts";
import { extractStorageKeyFromUrl } from "./storage/index";
import { StorageObjectNotFoundError } from "./storage/storage.provider";
import { loadCertificateImage } from "./certificate-image-cache";
import { logger } from "./logger";
import { drawTextZone, embedZoneFonts } from "./pdf/zone-layout";

// Shared with badges (./pdf/zone-layout); certificates-pdf.ts reaches them here.
export { hexToRgb, truncateTextToWidth } from "./pdf/zone-layout";

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

  const fonts = await embedZoneFonts(pdfDoc);

  for (const zone of template.zones) {
    drawTextZone(
      page,
      zone,
      resolvedValues[zone.variable] || "",
      fonts,
      templateWidth,
      templateHeight,
    );
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
