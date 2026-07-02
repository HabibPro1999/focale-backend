import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compressFile } from "./compress";
import { IntegrationError } from "../errors";

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
});
