import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { generateNetworkingReportPdf } from "./networking-report-pdf";
describe("networking PDF exports", () => {
  it("embeds multilingual text and paginates complete records", async () => {
    const bytes = await generateNetworkingReportPdf(
      "Rencontres B2B — ملتقى الأعمال",
      ["Name", "Company", "Description"],
      Array.from({ length: 30 }, (_, i) => [
        `Participant ${i} — محمد`,
        "Société médicale",
        "Investment and distribution partnerships. ".repeat(12),
      ]),
    );
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });
  it("produces a valid empty report", async () => {
    const bytes = await generateNetworkingReportPdf(
      "No meetings yet",
      ["Meeting", "Date"],
      [],
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});
