import { PDFDocument, type PDFPage } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { bidiTextWidth } from "./bidi-text";
import { drawTextZone, embedZoneFonts, hexToRgb, truncateTextToWidth } from "./zone-layout";

const ZONE = {
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fontSize: 20,
  fontWeight: "bold" as const,
  color: "#000000",
  textAlign: "left" as const,
};

async function drawnRuns(value: string) {
  const doc = await PDFDocument.create();
  const fonts = await embedZoneFonts(doc);
  const calls: Array<{ text: string; x: number; size: number }> = [];
  const page = {
    drawText: (text: string, options: { x: number; size: number }) =>
      calls.push({ text, x: options.x, size: options.size }),
  } as unknown as PDFPage;
  drawTextZone(page, ZONE, value, fonts, 900, 60);
  return { calls, font: fonts.boldFont };
}

describe("drawTextZone with mixed-direction text", () => {
  it("draws a Latin line's Arabic part as its own run, after the Latin part", async () => {
    const { calls } = await drawnRuns("Jihed Bouguerra — TEST — فريق تنظيم المنتدى");
    expect(calls.map((call) => call.text)).toEqual([
      "Jihed Bouguerra — TEST — ",
      "فريق تنظيم المنتدى",
    ]);
  });

  it("keeps digits in order inside Arabic and lays runs out left to right", async () => {
    const { calls, font } = await drawnRuns("المؤتمر الوطني 2026");
    // Right-to-left line: the year sits at the visual left, the Arabic words after it.
    expect(calls.map((call) => call.text)).toEqual(["2026", "المؤتمر الوطني "]);
    for (let i = 1; i < calls.length; i++) {
      const previous = calls[i - 1]!;
      expect(calls[i]!.x).toBeCloseTo(previous.x + font.widthOfTextAtSize(previous.text, previous.size), 5);
    }
  });

  it("draws a Latin-only line in one call", async () => {
    const { calls } = await drawnRuns("Amira Ben Salah");
    expect(calls.map((call) => call.text)).toEqual(["Amira Ben Salah"]);
  });
});

describe("bidi-aware measuring", () => {
  it("measures shaped Arabic, not the unshaped string", async () => {
    const doc = await PDFDocument.create();
    const { boldFont } = await embedZoneFonts(doc);
    const mixed = "TEST — فريق تنظيم";
    const runsWidth = boldFont.widthOfTextAtSize("TEST — ", 20) + boldFont.widthOfTextAtSize("فريق تنظيم", 20);
    expect(bidiTextWidth(boldFont, mixed, 20)).toBeCloseTo(runsWidth, 5);
    const truncated = truncateTextToWidth(boldFont, mixed, 20, runsWidth - 1);
    expect(truncated.endsWith("...")).toBe(true);
    expect(bidiTextWidth(boldFont, truncated, 20)).toBeLessThanOrEqual(runsWidth - 1);
  });
});

describe("hexToRgb", () => {
  it("resolves CSS color names", () => {
    expect(hexToRgb("red")).toEqual({ r: 1, g: 0, b: 0 });
    expect(hexToRgb("navy")).toEqual({ r: 0, g: 0, b: 128 / 255 });
  });

  it("falls back to black for an unknown name", () => {
    expect(hexToRgb("not-a-color")).toEqual({ r: 0, g: 0, b: 0 });
  });
});
