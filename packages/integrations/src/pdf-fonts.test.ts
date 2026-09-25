import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { dejaVuFontPath, embedDejaVuFont, loadFontBytes } from "./pdf-fonts";

describe("pdf-fonts", () => {
  it("reads each font file once per process", async () => {
    const path = dejaVuFontPath("DejaVuSerif.ttf");
    const first = loadFontBytes(path);
    expect(loadFontBytes(path)).toBe(first);
    expect((await first).byteLength).toBeGreaterThan(100_000);
  });

  it("does not cache a failed read", async () => {
    const missing = `${dejaVuFontPath("DejaVuSans.ttf")}.missing`;
    const first = loadFontBytes(missing);
    await expect(first).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    const second = loadFontBytes(missing);
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();
  });

  it("embeds a subset Unicode face that covers Greek, math and Arabic", async () => {
    const doc = await PDFDocument.create();
    const font = await embedDejaVuFont(doc, "DejaVuSans.ttf");
    const glyphs = new Set(font.getCharacterSet());
    for (const char of "αΔ≤≥−محمد") {
      expect(glyphs.has(char.codePointAt(0)!), char).toBe(true);
    }
    const page = doc.addPage();
    page.drawText("α ≤ 30 محمد", { x: 10, y: 10, size: 12, font });
    // Subsetting keeps the document far below the 700 KB font file.
    expect((await doc.save()).byteLength).toBeLessThan(60_000);
  });
});
