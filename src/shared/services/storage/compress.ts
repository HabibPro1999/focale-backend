import sharp from "sharp";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

export interface CompressedFile {
  buffer: Buffer;
  contentType: string;
  ext: string;
}

/**
 * Compresses an image buffer to WebP format with size constraints.
 * Resizes to max 2048x2048 while maintaining aspect ratio.
 */
export async function compressImage(buffer: Buffer): Promise<CompressedFile> {
  const compressed = await sharp(buffer)
    .resize(2048, 2048, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .toBuffer();

  return {
    buffer: compressed,
    contentType: "image/webp",
    ext: "webp",
  };
}

/**
 * Compresses a file based on its MIME type.
 * - Images: converted to WebP
 * - PDFs: passed through unchanged
 * - Others: throws error
 */
export async function compressFile(
  buffer: Buffer,
  mimetype: string,
): Promise<CompressedFile> {
  if (mimetype.startsWith("image/")) {
    return compressImage(buffer);
  }

  if (mimetype === "application/pdf") {
    return {
      buffer,
      contentType: "application/pdf",
      ext: "pdf",
    };
  }

  throw new AppError(
      `Unsupported file type: ${mimetype}`,
      400,
    ErrorCodes.INVALID_FILE_TYPE,
  );
}
