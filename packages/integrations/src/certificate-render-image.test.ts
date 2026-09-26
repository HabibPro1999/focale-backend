import { crc32, deflateSync } from "node:zlib";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import type { CertificateZone } from "@app/contracts";

// Golden-image tests for the 3.8 render pipeline, on fixture templates built
// here with the real sharp (no real templates are available): the derived
// render image must look like the original drawn on a white page, and a PDF
// rendered from it must have the same page size, image placement and text
// positions as one rendered from the original (the pre-3.8 renderer).
// Visual QA on real production templates is still required before release.

const stored = new Map<string, Buffer>();
const mockDownload = vi.fn(async (key: string) => {
  const buffer = stored.get(key);
  if (!buffer) throw new Error(`no object ${key}`);
  return { buffer, contentType: null };
});
vi.mock("./storage/index", async (importOriginal) => ({
  extractStorageKeyFromUrl: (
    await importOriginal<typeof import("./storage/index")>()
  ).extractStorageKeyFromUrl,
  getStorageProvider: vi.fn(() => ({ download: mockDownload })),
}));
vi.mock("@app/db", () => ({}));

import {
  CERTIFICATE_RENDER_MAX_PX,
  certificateRenderImageKey,
  deriveCertificateRenderImage,
} from "./certificate-render-image";
import { certificateImageCache } from "./certificate-image-cache";
import { generateCertificatePdf } from "./certificates-pdf";
import { StorageObjectNotFoundError } from "./storage/storage.provider";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Rgba = [number, number, number, number];

/** RGBA raw pixels: transparent, with filled rectangles [x0, y0, x1, y1). */
function rgbaCanvas(
  width: number,
  height: number,
  rects: Array<{ box: [number, number, number, number]; color: Rgba }>,
): Buffer {
  const raw = Buffer.alloc(width * height * 4);
  for (const { box, color } of rects) {
    const [x0, y0, x1, y1] = box;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) raw.set(color, (y * width + x) * 4);
    }
  }
  return raw;
}

const PNG_W = 1200;
const PNG_H = 850;
const pngRects: Array<{ box: [number, number, number, number]; color: Rgba }> = [
  { box: [100, 100, 500, 400], color: [255, 0, 0, 255] }, // opaque red
  { box: [600, 450, 1100, 800], color: [0, 0, 0, 128] }, // half-transparent black
  { box: [700, 100, 1000, 300], color: [0, 90, 200, 255] }, // opaque blue
];
const pngRaw = rgbaCanvas(PNG_W, PNG_H, pngRects);

/** The PNG fixture composited over white, computed independently of sharp. */
function pngOverWhite(): Buffer {
  const out = Buffer.alloc(PNG_W * PNG_H * 3);
  for (let i = 0; i < PNG_W * PNG_H; i++) {
    const a = pngRaw[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = Math.round(pngRaw[i * 4 + c] * a + 255 * (1 - a));
    }
  }
  return out;
}

async function rawRgb(image: Buffer): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function pixel(img: { data: Buffer; width: number; channels: number }, x: number, y: number): number[] {
  const at = (y * img.width + x) * img.channels;
  return Array.from(img.data.subarray(at, at + img.channels));
}

/** Header-only PNG declaring width x height (IDAT empty). */
function craftedPng(width: number, height: number): Buffer {
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(0))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface Fixture {
  name: string;
  original: Buffer;
  ext: "png" | "jpg";
}

let pngWithAlpha: Fixture;
let largeJpeg: Fixture;
let cmykJpeg: Fixture;

beforeAll(async () => {
  pngWithAlpha = {
    name: "png-alpha",
    ext: "png",
    original: await sharp(pngRaw, { raw: { width: PNG_W, height: PNG_H, channels: 4 } })
      .png()
      .toBuffer(),
  };
  // 15 MP: over the 3508 px render size, under the 20 MP upload limit. A black
  // square at (2000..2500, 1800..2100) to check placement after the downscale.
  const square = await sharp({
    create: { width: 500, height: 300, channels: 3, background: "#000000" },
  })
    .png()
    .toBuffer();
  largeJpeg = {
    name: "large-jpeg",
    ext: "jpg",
    original: await sharp({
      create: { width: 5000, height: 3000, channels: 3, background: "#f0f0f0" },
    })
      .composite([{ input: square, left: 2000, top: 1800 }])
      .jpeg({ quality: 90 })
      .toBuffer(),
  };
  // CMYK JPEG: white page, a black block and a cyan block.
  const rgb = await sharp(
    rgbaCanvas(800, 600, [
      { box: [0, 0, 800, 600], color: [255, 255, 255, 255] },
      { box: [100, 100, 300, 300], color: [0, 0, 0, 255] },
      { box: [500, 100, 700, 300], color: [0, 174, 239, 255] },
    ]),
    { raw: { width: 800, height: 600, channels: 4 } },
  )
    .removeAlpha()
    .png()
    .toBuffer();
  cmykJpeg = {
    name: "cmyk-jpeg",
    ext: "jpg",
    original: await sharp(rgb).toColourspace("cmyk").jpeg({ quality: 95 }).toBuffer(),
  };
}, 60_000);

// Image decoding and PDF parsing are slow under a loaded CI runner.
const SLOW = { timeout: 60_000 };

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

describe("deriveCertificateRenderImage (3.8)", SLOW, () => {
  it("flattens a PNG with alpha onto white, as the old renderer's blank page showed it", async () => {
    const render = await deriveCertificateRenderImage(pngWithAlpha.original);
    const meta = await sharp(render.buffer).metadata();
    expect(render.contentType).toBe("image/jpeg");
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(["jpeg", PNG_W, PNG_H, false]);
    expect([render.width, render.height]).toEqual([PNG_W, PNG_H]);
    expect(meta.space).toBe("srgb");
    expect(meta.chromaSubsampling).toBe("4:4:4");

    const got = await rawRgb(render.buffer);
    expect(got.channels).toBe(3);
    const want = pngOverWhite();
    let total = 0;
    for (let i = 0; i < want.length; i++) total += Math.abs(got.data[i] - want[i]);
    // Golden comparison: mean absolute error per channel, JPEG q88 4:4:4.
    expect(total / want.length).toBeLessThan(1.5);
    // Interior probes, away from JPEG edge ringing.
    const near = (actual: number[], expected: number[], tolerance = 6) =>
      actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance);
    expect(near(pixel(got, 20, 20), [255, 255, 255])).toBe(true); // transparent → white
    expect(near(pixel(got, 300, 250), [255, 0, 0])).toBe(true);
    expect(near(pixel(got, 850, 200), [0, 90, 200])).toBe(true);
    expect(near(pixel(got, 850, 600), [127, 127, 127])).toBe(true); // 50% black over white
  });

  it("scales a large JPEG down to 3508 px on the long edge and keeps content in place", async () => {
    const render = await deriveCertificateRenderImage(largeJpeg.original);
    expect(render.width).toBe(CERTIFICATE_RENDER_MAX_PX);
    expect(render.height).toBe(Math.round((3000 * CERTIFICATE_RENDER_MAX_PX) / 5000));

    const got = await rawRgb(render.buffer);
    const scale = render.width / 5000;
    // Centre of the black square, and a point well outside it.
    const inside = pixel(got, Math.round(2250 * scale), Math.round(1950 * scale));
    const outside = pixel(got, Math.round(1500 * scale), Math.round(1950 * scale));
    expect(Math.max(...inside)).toBeLessThan(20);
    expect(Math.min(...outside)).toBeGreaterThan(225);
    // Square edges land within a pixel of their scaled position.
    const row = Math.round(1950 * scale);
    const leftEdge = Math.round(2000 * scale);
    expect(Math.max(...pixel(got, leftEdge - 3, row))).toBeGreaterThan(200);
    expect(Math.max(...pixel(got, leftEdge + 3, row))).toBeLessThan(40);
  });

  it("converts a CMYK JPEG to sRGB without inverting it", async () => {
    expect((await sharp(cmykJpeg.original).metadata()).space).toBe("cmyk");

    const render = await deriveCertificateRenderImage(cmykJpeg.original);
    const meta = await sharp(render.buffer).metadata();
    expect([meta.space, meta.channels, render.width, render.height]).toEqual(["srgb", 3, 800, 600]);

    const got = await rawRgb(render.buffer);
    expect(Math.min(...pixel(got, 400, 500))).toBeGreaterThan(240); // white stays white
    expect(Math.max(...pixel(got, 200, 200))).toBeLessThan(45); // black stays black
    const [r, g, b] = pixel(got, 600, 200); // cyan stays cyan
    expect(r).toBeLessThan(60);
    expect(g).toBeGreaterThan(120);
    expect(b).toBeGreaterThan(180);
  });

  it("does not auto-rotate: the stored pixel grid (the page size) is kept", async () => {
    const oriented = await sharp({
      create: { width: 300, height: 100, channels: 3, background: "#ff0000" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const meta = await sharp(oriented).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([300, 100, 6]);

    const render = await deriveCertificateRenderImage(oriented);
    expect([render.width, render.height]).toEqual([300, 100]);
    expect((await sharp(render.buffer).metadata()).orientation).toBeUndefined();
  });

  it("keeps the upload decode limits (0.7): a PNG declaring 16384×16384 is refused", async () => {
    await expect(deriveCertificateRenderImage(craftedPng(16384, 16384))).rejects.toThrow();
  });

  it("refuses a PNG whose pixel data cannot be decoded", async () => {
    await expect(deriveCertificateRenderImage(craftedPng(64, 64))).rejects.toThrow();
  });

  it("names the render key beside the event's template originals", () => {
    expect(certificateRenderImageKey("evt-1", "tpl-1", "u-1")).toBe(
      "evt-1/certificates/tpl-1-u-1-render.jpg",
    );
  });
});

// ---------------------------------------------------------------------------
// Rendering: the render image changes nothing but the embedded image
// ---------------------------------------------------------------------------

const zones: CertificateZone[] = [
  { id: "z1", x: 10, y: 30, width: 80, height: 15, variable: "fullName", fontSize: null, fontWeight: "bold", color: "#1a2b3c", textAlign: "center" },
  { id: "z2", x: 5, y: 60, width: 40, height: 8, variable: "eventName", fontSize: 24, fontWeight: "normal", color: "black", textAlign: "left" },
  { id: "z3", x: 55, y: 80, width: 40, height: 6, variable: "eventDate", fontSize: null, fontWeight: "normal", color: "rgb(200, 0, 0)", textAlign: "right" },
];
const values = { fullName: "Ada Lovelace-Müller", eventName: "Focale Congress", eventDate: "May 1, 2026" };

/** Decoded content stream of page 1, resource names made comparable. */
function pageContent(doc: PDFDocument): string {
  const contents = doc.getPage(0).node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => doc.context.lookup(ref))
      : [contents];
  return streams
    .map((stream) => Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString("latin1"))
    .join("\n")
    .replace(/\/([A-Za-z]+)-\d+(?:-\d+)?/g, "/$1");
}

/** The single image XObject drawn on page 1. */
function pageImage(doc: PDFDocument): PDFRawStream {
  const xObjects = doc.getPage(0).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  const images = xObjects.values().map((ref) => doc.context.lookup(ref) as PDFRawStream);
  expect(images).toHaveLength(1);
  return images[0];
}

function imageEntry(image: PDFRawStream, key: string): string | number | undefined {
  const value = image.dict.get(PDFName.of(key));
  if (value instanceof PDFNumber) return value.asNumber();
  return value?.toString();
}

describe("certificate PDF with the render image (3.8)", SLOW, () => {
  beforeEach(() => {
    certificateImageCache.clear();
    stored.clear();
    mockDownload.mockClear();
  });

  async function renderBoth(fixture: Fixture) {
    const meta = await sharp(fixture.original).metadata();
    const originalKey = `evt/certificates/tpl-${fixture.name}-u1.${fixture.ext}`;
    const renderKey = certificateRenderImageKey("evt", `tpl-${fixture.name}`, "u1");
    const render = await deriveCertificateRenderImage(fixture.original);
    stored.set(originalKey, fixture.original);
    stored.set(renderKey, render.buffer);
    const base = {
      templateUrl: `https://cdn.example.com/${originalKey}`,
      templateWidth: meta.width!,
      templateHeight: meta.height!,
      zones,
    };
    const before = await PDFDocument.load(
      await generateCertificatePdf({ ...base, renderImageKey: null }, values),
    );
    const after = await PDFDocument.load(
      await generateCertificatePdf({ ...base, renderImageKey: renderKey }, values),
    );
    return { before, after, render, base, renderKey };
  }

  it.each([
    ["PNG with alpha", () => pngWithAlpha],
    ["large JPEG", () => largeJpeg],
    ["CMYK JPEG", () => cmykJpeg],
  ])("%s: same page size, image placement and text positions as the original-image render", async (_label, fixture) => {
    const { before, after, render, base } = await renderBoth(fixture());

    for (const doc of [before, after]) {
      const { width, height } = doc.getPage(0).getSize();
      expect([width, height]).toEqual([base.templateWidth, base.templateHeight]);
    }
    // The whole drawing program (image matrix, every text position, size and
    // color) is identical; only the image object behind it differs.
    const content = pageContent(after);
    expect(content).toBe(pageContent(before));
    expect(content).toContain(`${base.templateWidth} 0 0 ${base.templateHeight} 0 0 cm`);

    const embedded = pageImage(after);
    expect(imageEntry(embedded, "Filter")).toBe("/DCTDecode");
    expect([imageEntry(embedded, "Width"), imageEntry(embedded, "Height")]).toEqual([
      render.width,
      render.height,
    ]);
    expect(imageEntry(embedded, "ColorSpace")).toBe("/DeviceRGB");
    expect(imageEntry(embedded, "SMask")).toBeUndefined();
  });

  it("the original-image fallback still embeds the PNG itself (with its alpha mask)", async () => {
    const { before } = await renderBoth(pngWithAlpha);
    const embedded = pageImage(before);
    expect(imageEntry(embedded, "Filter")).toBe("/FlateDecode");
    expect(imageEntry(embedded, "SMask")).toBeDefined();
    expect([imageEntry(embedded, "Width"), imageEntry(embedded, "Height")]).toEqual([PNG_W, PNG_H]);
  });

  it("reads the render image, not the original, when the template has one", async () => {
    const { renderKey } = await renderBoth(largeJpeg);
    // renderBoth rendered once without and once with the render key.
    expect(mockDownload.mock.calls.map(([key]) => key)).toEqual([
      "evt/certificates/tpl-large-jpeg-u1.jpg",
      renderKey,
    ]);
  });

  it("falls back to the original when the render image is missing from storage", async () => {
    const originalKey = "evt/certificates/tpl-x-u1.png";
    stored.set(originalKey, pngWithAlpha.original);
    mockDownload.mockImplementationOnce(async (key: string) => {
      throw new StorageObjectNotFoundError(key);
    });

    const pdf = await PDFDocument.load(
      await generateCertificatePdf(
        {
          templateUrl: `https://cdn.example.com/${originalKey}`,
          templateWidth: PNG_W,
          templateHeight: PNG_H,
          renderImageKey: "evt/certificates/tpl-x-u1-render.jpg",
          zones,
        },
        values,
      ),
    );

    expect(imageEntry(pageImage(pdf), "Filter")).toBe("/FlateDecode");
    expect(mockDownload.mock.calls.map(([key]) => key)).toEqual([
      "evt/certificates/tpl-x-u1-render.jpg",
      originalKey,
    ]);
  });

  it("other render-image storage errors fail the certificate (no silent fallback)", async () => {
    mockDownload.mockRejectedValueOnce(new Error("storage down"));
    await expect(
      generateCertificatePdf(
        {
          templateUrl: "https://cdn.example.com/evt/certificates/tpl-y.png",
          templateWidth: 10,
          templateHeight: 10,
          renderImageKey: "evt/certificates/tpl-y-render.jpg",
          zones: [],
        },
        {},
      ),
    ).rejects.toThrow("storage down");
  });
});
