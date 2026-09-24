import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compressFile, compressImage } from "./compress";
import { IMAGE_INPUT_LIMITS } from "./image-limits";
import { IntegrationError } from "../errors";

/**
 * 8-bit grayscale PNG with a valid IHDR CRC. Without `pixels` the IDAT is empty:
 * a few bytes that declare `width`×`height`, so no bitmap is ever allocated.
 */
function craftedPng(width: number, height: number, pixels = false): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth; colour type 0 (grayscale), no interlace
  const rows = pixels ? Buffer.alloc((width + 1) * height) : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const invalidImage = { name: "IntegrationError", status: 400, code: "FIL_10001" };

// ponytail: check behind the branch logic — no legacy test existed for compress.
describe("compressFile", () => {
  it("re-encodes any image to WebP (max 2048, quality 80)", async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const out = await compressFile(png, "image/png");
    expect(out.contentType).toBe("image/webp");
    expect(out.ext).toBe("webp");
    expect((await sharp(out.buffer).metadata()).format).toBe("webp");
  });

  it("passes PDFs through unchanged", async () => {
    const pdf = Buffer.from("%PDF-1.4 fake");
    const out = await compressFile(pdf, "application/pdf");
    expect(out).toEqual({ buffer: pdf, contentType: "application/pdf", ext: "pdf" });
  });

  it("rejects unsupported types with a 400 INVALID_FILE_TYPE IntegrationError", async () => {
    await expect(compressFile(Buffer.from("x"), "text/plain")).rejects.toMatchObject(
      { name: "IntegrationError", status: 400, code: "FIL_10001" },
    );
    await expect(compressFile(Buffer.from("x"), "text/plain")).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });

  describe("decode limits (IMAGE_INPUT_LIMITS)", () => {
    it("is the shared 20-megapixel limit", () => {
      expect(IMAGE_INPUT_LIMITS.limitInputPixels).toBe(20_000_000);
    });

    it("rejects a PNG declaring 16384×16384 with a 400 IntegrationError", async () => {
      const bomb = craftedPng(16384, 16384);
      expect(bomb.length).toBeLessThan(100);
      await expect(compressImage(bomb)).rejects.toMatchObject(invalidImage);
      await expect(compressFile(bomb, "image/png")).rejects.toBeInstanceOf(IntegrationError);
    });

    it("rejects a real image just over 20 megapixels (4473×4473) that sharp's default limit would accept", async () => {
      await expect(compressImage(craftedPng(4473, 4473, true))).rejects.toMatchObject(
        invalidImage,
      );
    });

    it("maps undecodable image bytes to a 400 IntegrationError instead of a raw sharp error", async () => {
      await expect(
        compressFile(Buffer.from("definitely not an image"), "image/png"),
      ).rejects.toMatchObject(invalidImage);
    });

    it("rejects a JPEG whose pixel data raises a libjpeg warning (failOn)", async () => {
      const jpeg = await sharp({
        create: { width: 16, height: 16, channels: 3, background: "red" },
      })
        .jpeg()
        .toBuffer();
      const sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
      // "Corrupt JPEG data: 3 extraneous bytes before marker 0xda" is a warning, not an error.
      const corrupt = Buffer.concat([jpeg.subarray(0, sos), Buffer.alloc(3), jpeg.subarray(sos)]);
      await expect(compressImage(corrupt)).rejects.toMatchObject(invalidImage);
    });

    it("still accepts an image just under the limit (4472×4472)", async () => {
      const out = await compressImage(craftedPng(4472, 4472, true));
      expect((await sharp(out.buffer).metadata()).width).toBe(2048);
    });
  });
});
