import { afterEach, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage } from "pdf-lib";
import type { AbstractBookData } from "@app/db";
import { generateAbstractBookPdf } from "./pdf";

afterEach(() => vi.restoreAllMocks());

it("keeps section order, two-column overflow and full-width book headings", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const date = new Date();
  const data: AbstractBookData = {
    eventName: "Scientific meeting",
    config: {
      bookFontFamily: "Arial", bookFontSize: 11, bookLineSpacing: 1.5,
      bookOrder: "BY_THEME", bookIncludeAuthorNames: true,
      additionalFieldsSchema: [{ id: "keywords", type: "text", label: "Keywords" }],
    },
    abstracts: Array.from({ length: 4 }, (_, i) => ({
      id: `abstract-${i}`, eventId: "event", authorFirstName: "Ada", authorLastName: "Lovelace",
      authorAffiliation: "University", authorEmail: "ada@example.com", authorEmailNormalized: "ada@example.com",
      authorPhone: "123", requestedType: "POSTER", status: "ACCEPTED", finalType: "POSTER",
      coAuthors: [], additionalFieldsData: { keywords: "Science" }, code: `P${i}`, codeNumber: i,
      content: { mode: "STRUCTURED", title: "  A study  ", introduction: "Intro",
        objective: "Objective text", methods: "Methods text", results: "A long result. ".repeat(150), conclusion: "Conclusion text" },
      contentVersion: 1, averageScore: 12, reviewCount: 2, presentedAt: null, presentedBy: null,
      finalFileKey: null, finalFileKind: null, finalFileSize: null, finalFileUploadedAt: null,
      editToken: "token", lastEditedAt: null, linkBaseUrl: null, registrationId: null,
      createdAt: date, updatedAt: date, themes: [{ id: "theme", label: "Research", sortOrder: 0 }],
    })),
  };
  const draw = vi.spyOn(PDFPage.prototype, "drawText");
  try {
    const { buffer, includedCount } = await generateAbstractBookPdf(data);
    const pdf = await PDFDocument.load(buffer);
    expect(includedCount).toBe(4);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(draw.mock.calls[0]).toEqual(["Scientific meeting", expect.objectContaining({ x: 54, y: 787.89, size: 22 })]);
    expect(draw.mock.calls[1]).toEqual(["Abstract Book", expect.objectContaining({ x: 54, size: 16 })]);
    const texts = draw.mock.calls.map(([text]) => text);
    expect(texts.filter(text => ["Introduction", "Objective", "Methods", "Results", "Conclusion", "Keywords"].includes(text)))
      .toEqual(Array.from({ length: 4 }, () => ["Introduction", "Objective", "Methods", "Results", "Conclusion", "Keywords"]).flat());
    expect(new Set(draw.mock.calls.map(([, options]) => options?.x))).toEqual(new Set([54, 306.64]));
  } finally {
    vi.useRealTimers();
  }
});
