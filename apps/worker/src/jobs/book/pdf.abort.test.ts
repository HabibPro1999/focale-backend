import { describe, expect, it, vi } from "vitest";
import type { AbstractBookData } from "@app/db";
import { generateAbstractBookPdf } from "./pdf";

// 3.4: the layout yields to the event loop every 20 abstracts (so the job's
// lease heartbeat keeps running) and stops there once its signal aborts
// (lost lease, timeout or shutdown).

function book(count: number): AbstractBookData {
  const abstracts = Array.from({ length: count }, (_, i) => ({
    id: `abs-${i}`,
    code: `A-${String(i + 1).padStart(3, "0")}`,
    codeNumber: i + 1,
    finalType: "ORAL_COMMUNICATION",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    authorFirstName: "Ada",
    authorLastName: "Lovelace",
    authorAffiliation: "Analytical Society",
    authorEmail: "ada@example.com",
    coAuthors: [],
    content: { title: `Abstract ${i + 1}`, mode: "FREE_TEXT", body: "<p>Body.</p>" },
    additionalFieldsData: {},
    themes: [],
  }));
  return {
    eventName: "Congress",
    config: {
      bookFontFamily: "Helvetica",
      bookFontSize: 10,
      bookLineSpacing: 1.3,
      bookOrder: "BY_CODE",
      bookIncludeAuthorNames: true,
      additionalFieldsSchema: [],
    },
    abstracts,
  } as unknown as AbstractBookData;
}

describe("generateAbstractBookPdf and its signal", () => {
  it("checks the signal every 20 abstracts and once before saving", async () => {
    const signal = new AbortController().signal;
    const check = vi.spyOn(signal, "throwIfAborted");
    const { includedCount } = await generateAbstractBookPdf(book(45), { signal });
    expect(includedCount).toBe(45);
    // Before abstracts 0, 20 and 40, then before save().
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("stops at its next yield once the signal aborts, with the abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    // Aborts while the render runs: only a render that yields can see it.
    setImmediate(() => controller.abort(reason));
    await expect(generateAbstractBookPdf(book(45), { signal: controller.signal })).rejects.toBe(reason);
  });

  it("renders without a signal", async () => {
    const { buffer, includedCount } = await generateAbstractBookPdf(book(2));
    expect(includedCount).toBe(2);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
