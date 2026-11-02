import { crc32, deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { ErrorCodes } from "@app/contracts";

// Template-image decode limits with the REAL sharp and file-type (the main
// certificates suite mocks both). Only the DB and storage are stubbed.
const { rootDb } = vi.hoisted(() => ({ rootDb: { executor: "root" } }));
vi.mock("@app/db", () => ({
  getDb: () => rootDb,
  getCertificateTemplateForUpload: vi.fn(),
  updateCertificateTemplateImage: vi.fn(),
}));
const storage = vi.hoisted(() => ({
  uploadPublic: vi.fn(),
  uploadPrivate: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStorageProvider: () => storage,
}));

import { getCertificateTemplateForUpload, updateCertificateTemplateImage } from "@app/db";
import { CertificatesService } from "./certificates.service";

/** 8-bit grayscale PNG with a valid IHDR CRC; without `pixels` the IDAT is empty. */
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
  ihdr[8] = 8;
  const rows = pixels ? Buffer.alloc((width + 1) * height) : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const service = new CertificatesService();
const file = (buffer: Buffer) => ({ buffer, filename: "cert.png", mimetype: "image/png" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCertificateTemplateForUpload).mockResolvedValue({
    id: "tpl-1",
    eventId: "evt-1",
    templateUrl: "",
    renderImageKey: null,
  });
  vi.mocked(updateCertificateTemplateImage).mockImplementation(
    async (_id, data) => ({ id: "tpl-1", ...data }) as never,
  );
  storage.uploadPublic.mockResolvedValue("https://cdn.example/evt-1/certificates/tpl-1.png");
  storage.uploadPrivate.mockImplementation(async (_buffer: Buffer, key: string) => key);
});

describe("certificate template image decode limits", () => {
  it("rejects a PNG declaring 16384×16384 with 400 VALIDATION_ERROR, nothing stored", async () => {
    await expect(
      service.uploadTemplateImage("tpl-1", file(craftedPng(16384, 16384))),
    ).rejects.toMatchObject({ statusCode: 400, code: ErrorCodes.VALIDATION_ERROR });
    expect(storage.uploadPublic).not.toHaveBeenCalled();
    expect(updateCertificateTemplateImage).not.toHaveBeenCalled();
  });

  it("rejects a real image just over 20 megapixels (4473×4473)", async () => {
    await expect(
      service.uploadTemplateImage("tpl-1", file(craftedPng(4473, 4473, true))),
    ).rejects.toMatchObject({ statusCode: 400, code: ErrorCodes.VALIDATION_ERROR });
    expect(storage.uploadPublic).not.toHaveBeenCalled();
  });

  it("still stores a small valid PNG at original resolution with its dimensions", async () => {
    const png = await sharp({
      create: { width: 30, height: 20, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();

    await service.uploadTemplateImage("tpl-1", file(png));

    expect(storage.uploadPublic).toHaveBeenCalledTimes(1);
    expect(storage.uploadPublic.mock.calls[0][0]).toBe(png);
    expect(updateCertificateTemplateImage).toHaveBeenCalledWith(
      "tpl-1",
      expect.objectContaining({
        templateWidth: 30,
        templateHeight: 20,
        renderImageWidth: 30,
        renderImageHeight: 20,
      }),
      rootDb,
    );
    // 3.8: the render image is a JPEG of the same size (small images are
    // never scaled up), stored beside the original.
    const [renderBuffer, renderKey, contentType] = storage.uploadPrivate.mock.calls[0];
    expect(renderKey).toMatch(/^evt-1\/certificates\/tpl-1-[0-9a-f-]{36}-render\.jpg$/);
    expect(contentType).toBe("image/jpeg");
    const meta = await sharp(renderBuffer as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 30, 20]);
  });

  it("refuses a PNG whose header is valid but whose pixels cannot be decoded (3.8), nothing stored", async () => {
    // The header-only metadata read accepts it; the render derivation decodes
    // the pixels and fails, so the upload is refused instead of every
    // certificate failing later.
    await expect(
      service.uploadTemplateImage("tpl-1", file(craftedPng(64, 64))),
    ).rejects.toMatchObject({ statusCode: 400, code: ErrorCodes.VALIDATION_ERROR });
    expect(storage.uploadPublic).not.toHaveBeenCalled();
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
    expect(updateCertificateTemplateImage).not.toHaveBeenCalled();
  });
});
