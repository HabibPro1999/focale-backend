// =============================================================================
// CERTIFICATE RENDER IMAGE (3.8)
// The copy of a template image the certificate renderer embeds: a flattened
// JPEG that pdf-lib's embedJpg copies into the PDF as is, instead of the pure
// JavaScript PNG decode (and re-encode) embedPng runs for every certificate.
// Derived once, when the image is uploaded (or by the backfill script), and
// stored beside the original.
// =============================================================================

import sharp from "sharp";
import { IMAGE_INPUT_LIMITS } from "./storage/image-limits";

/** Longest side of a render image: an A4 page at 300 dpi. */
export const CERTIFICATE_RENDER_MAX_PX = 3508;
export const CERTIFICATE_RENDER_JPEG_QUALITY = 88;

export interface CertificateRenderImage {
  buffer: Buffer;
  /** Pixel size of the render image (not of the original). */
  width: number;
  height: number;
  contentType: "image/jpeg";
}

/**
 * Derive the render image from an uploaded template image (PNG or JPEG):
 * - decoded under IMAGE_INPUT_LIMITS (20 MP, strict), like every upload;
 * - transparency flattened onto white, which is what a transparent PNG looked
 *   like on the old renderer's blank PDF page;
 * - scaled down to fit CERTIFICATE_RENDER_MAX_PX (never up), aspect kept;
 * - converted to sRGB (CMYK and grayscale inputs included), JPEG quality 88
 *   with 4:4:4 chroma, so thin colored lines and small text stay sharp.
 * No EXIF auto-rotation: the old renderer drew the stored pixels as they are,
 * and the page keeps the original's pixel size, so positions do not move.
 * Throws when the input cannot be decoded or is over the limits.
 */
export async function deriveCertificateRenderImage(
  input: Buffer,
): Promise<CertificateRenderImage> {
  const { data, info } = await sharp(input, IMAGE_INPUT_LIMITS)
    .flatten({ background: "#ffffff" })
    .resize(CERTIFICATE_RENDER_MAX_PX, CERTIFICATE_RENDER_MAX_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .toColourspace("srgb")
    .jpeg({ quality: CERTIFICATE_RENDER_JPEG_QUALITY, chromaSubsampling: "4:4:4" })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    width: info.width,
    height: info.height,
    contentType: "image/jpeg",
  };
}

/**
 * Storage key of a render image, beside the template originals of the event:
 * `<eventId>/certificates/<templateId>-<id>-render.jpg`. On upload `id` is the
 * one in the original's key (`<templateId>-<id>.<ext>`); the backfill uses a
 * fresh one, so a key is never written twice.
 */
export function certificateRenderImageKey(
  eventId: string,
  templateId: string,
  id: string,
): string {
  return `${eventId}/certificates/${templateId}-${id}-render.jpg`;
}
