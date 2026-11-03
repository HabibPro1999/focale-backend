import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage } from "pdf-lib";
import sharp from "sharp";
import { seedBadgeZones, type BadgeZone } from "@app/contracts";

const mockDownload = vi.fn();
vi.mock("../storage/index", () => ({ getStorageProvider: () => ({ download: mockDownload }) }));

import { StorageObjectNotFoundError } from "../storage/storage.provider";
import { certificateImageCache } from "../certificate-image-cache";
import { GOLDEN_MATRIX, GOLDEN_REGISTRATION_ID } from "../email/attachments/checkin-qr.golden";
import { badgeValuesFromContext, generateBadgePdf, mmToPt, type BadgeTemplateData } from "./badge-pdf";

const qrZone: BadgeZone = { kind: "qr", id: "qr", x: 25, y: 10, width: 50, height: 80 };
const textZone = (variable: string, overrides: Partial<BadgeZone> = {}): BadgeZone => ({
  kind: "text", id: variable, x: 5, y: 5, width: 90, height: 15, variable,
  fontSize: null, fontWeight: "bold", color: "#112233", textAlign: "center",
  ...overrides,
} as BadgeZone);

const template = (overrides: Partial<BadgeTemplateData> = {}): BadgeTemplateData => ({
  id: "badge-1",
  widthMm: 90,
  heightMm: 55,
  renderImageKey: null,
  zones: [qrZone],
  ...overrides,
});

let rectangles: ReturnType<typeof vi.spyOn>;
let texts: ReturnType<typeof vi.spyOn>;
let images: ReturnType<typeof vi.spyOn>;
let paths: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  certificateImageCache.clear();
  rectangles = vi.spyOn(PDFPage.prototype, "drawRectangle");
  texts = vi.spyOn(PDFPage.prototype, "drawText");
  images = vi.spyOn(PDFPage.prototype, "drawImage");
  paths = vi.spyOn(PDFPage.prototype, "drawSvgPath");
});
afterEach(() => vi.restoreAllMocks());

type Rect = { x: number; y: number; width: number; height: number; color: { red: number } };
const rects = () => rectangles.mock.calls.map(([options]) => options as Rect);

describe("generateBadgePdf", () => {
  it.each([
    [90, 55],
    [85.6, 54],
    [105, 148],
  ])("makes one %s x %s mm page, in points (mm * 72 / 25.4), that pdf-lib parses", async (widthMm, heightMm) => {
    const pdf = await generateBadgePdf(template({ widthMm, heightMm }), {}, GOLDEN_REGISTRATION_ID);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    const size = doc.getPage(0).getSize();
    expect(size.width).toBeCloseTo((widthMm * 72) / 25.4, 6);
    expect(size.height).toBeCloseTo((heightMm * 72) / 25.4, 6);
    expect(mmToPt(25.4)).toBe(72);
  });

  it("draws the QR as the golden matrix: one black path of row runs on a white square with a 1-module quiet zone, centred", async () => {
    await generateBadgePdf(template(), {}, GOLDEN_REGISTRATION_ID);

    const pageW = mmToPt(90);
    const pageH = mmToPt(55);
    const zoneW = 0.5 * pageW;
    const zoneH = 0.8 * pageH;
    const side = Math.min(zoneW, zoneH);
    const left = 0.25 * pageW + (zoneW - side) / 2;
    const bottom = pageH - (0.1 * pageH + (zoneH - side) / 2) - side;

    // Only the white square is a rectangle.
    const [white, ...others] = rects();
    expect(others).toEqual([]);
    expect(white!.color.red).toBe(1);
    expect(white!.x).toBeCloseTo(left, 9);
    expect(white!.y).toBeCloseTo(bottom, 9);
    expect(white!.width).toBeCloseTo(side, 9);
    expect(white!.height).toBeCloseTo(side, 9);

    // One path, origin at the first module (inside the quiet zone), scaled
    // to the module size: 29 modules + 1 quiet module per side.
    expect(paths).toHaveBeenCalledTimes(1);
    const [path, options] = paths.mock.calls[0]! as [string, { x: number; y: number; scale: number; color: { red: number } }];
    const unit = side / 31;
    expect(options.scale).toBeCloseTo(unit, 9);
    expect(options.x).toBeCloseTo(left + unit, 9);
    expect(options.y).toBeCloseTo(bottom + side - unit, 9);
    expect(options.color.red).toBe(0);

    const grid = GOLDEN_MATRIX.map((line) => Array.from(line, () => "0"));
    const runs = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
    expect(runs.map((m) => m[0]).join("")).toBe(path); // nothing else in the path
    for (const [, col, row, length, back] of runs) {
      expect(back).toBe(length);
      for (let c = Number(col); c < Number(col) + Number(length); c++) grid[Number(row)]![c] = "1";
    }
    expect(grid.map((line) => line.join(""))).toEqual(GOLDEN_MATRIX);
    expect(runs).toHaveLength(GOLDEN_MATRIX.join("|").match(/1+/g)!.length);
  });

  it("draws text zones from the values by variable id, and skips missing, empty and '—' values", async () => {
    await generateBadgePdf(
      template({
        zones: [
          textZone("fullName"),
          textZone("form_company", { id: "c", y: 80 }),
          textZone("registrationNumber", { id: "n", y: 90 }),
          textZone("eventName", { id: "e", y: 70 }),
          textZone("phone", { id: "p", y: 60 }),
          qrZone,
        ],
      }),
      { fullName: "ليلى Müller", form_company: "Focale", registrationNumber: "", phone: "—" },
      GOLDEN_REGISTRATION_ID,
    );
    expect(texts.mock.calls.map(([text]) => text)).toEqual(["ليلى Müller", "Focale"]);
    const [, options] = texts.mock.calls[0]!;
    expect(options).toMatchObject({ color: { red: 0x11 / 255, green: 0x22 / 255, blue: 0x33 / 255 } });
  });

  it("renders the seeded layout: the bold full name on top and the QR", async () => {
    const pdf = await generateBadgePdf(template({ zones: seedBadgeZones(90, 55) }), { fullName: "John Doe" }, GOLDEN_REGISTRATION_ID);
    expect(texts.mock.calls.map(([text]) => text)).toEqual(["John Doe"]);
    expect(rects()).toHaveLength(1);
    expect(paths).toHaveBeenCalledTimes(1);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("cover-fits the background JPEG to the page, centred", async () => {
    const jpeg = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
    mockDownload.mockResolvedValue({ buffer: jpeg, contentType: "image/jpeg" });

    await generateBadgePdf(template({ renderImageKey: "evt/badges/b-1-u-render.jpg" }), {}, GOLDEN_REGISTRATION_ID);

    expect(mockDownload).toHaveBeenCalledWith("evt/badges/b-1-u-render.jpg");
    const pageW = mmToPt(90);
    const pageH = mmToPt(55);
    const scale = Math.max(pageW / 200, pageH / 100);
    const [, options] = images.mock.calls[0]!;
    expect(options).toEqual({
      x: (pageW - 200 * scale) / 2,
      y: (pageH - 100 * scale) / 2,
      width: 200 * scale,
      height: 100 * scale,
    });
    expect(Math.min((options as { width: number }).width - pageW, (options as { height: number }).height - pageH)).toBeCloseTo(0, 9);
  });

  it("renders without the background when its image is gone from storage, and rethrows other storage errors", async () => {
    mockDownload.mockRejectedValueOnce(new StorageObjectNotFoundError("gone"));
    const pdf = await generateBadgePdf(template({ renderImageKey: "k" }), {}, GOLDEN_REGISTRATION_ID);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    expect(images).not.toHaveBeenCalled();

    mockDownload.mockRejectedValueOnce(new Error("storage down"));
    await expect(generateBadgePdf(template({ renderImageKey: "k2" }), {}, GOLDEN_REGISTRATION_ID)).rejects.toThrow("storage down");
  });
});

describe("badgeValuesFromContext", () => {
  it("keeps the context's text values only", () => {
    expect(badgeValuesFromContext({ fullName: "A", form_x: "B", _certificateTemplateIds: ["t"], count: 2 })).toEqual({
      fullName: "A",
      form_x: "B",
    });
  });
});
