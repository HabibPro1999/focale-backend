// =============================================================================
// BIDI PDF TEXT
// pdf-lib's drawText hands a whole string to fontkit, which shapes and orders
// it by the string's first script only: a Latin line with an Arabic part prints
// the Arabic unjoined and in the wrong word order, and digits inside Arabic
// come out reversed (2026 as 6202). Split the text into bidi runs in visual
// order (bidi-js, UAX #9) and draw them one after another, left to right.
// =============================================================================

import bidiFactory from "bidi-js";
import type { PDFFont } from "pdf-lib";

const bidi = bidiFactory();

export type TextDirection = "ltr" | "rtl" | "auto";

/** Visual runs retain logical Arabic text for shaping while Latin numbers remain LTR. */
export function pdfTextRuns(value: string, direction: TextDirection = "auto"): string[] {
  if (!value) return [];
  const embedding = bidi.getEmbeddingLevels(value, direction);
  const indices = bidi.getReorderedIndices(value, embedding);
  const visualPosition = new Map(indices.map((original, visual) => [original, visual]));
  // Rule L4: brackets and similar pairs inside right-to-left runs take their mirrored glyph.
  const mirrored = bidi.getMirroredCharactersMap(value, embedding.levels);
  const runs: Array<{ text: string; position: number }> = [];
  for (let start = 0; start < value.length; ) {
    let end = start + 1;
    while (end < value.length && embedding.levels[end] === embedding.levels[start]) end++;
    let content = "";
    for (let index = start; index < end; index++) content += mirrored.get(index) ?? value[index];
    // Fontkit handles Arabic/Hebrew shaping and glyph order. Neutral-only odd runs still need reversal.
    if (embedding.levels[start]! & 1 && !/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(content)) {
      content = Array.from(content).reverse().join("");
    }
    runs.push({
      text: content,
      position: Math.min(
        ...Array.from({ length: end - start }, (_, offset) => visualPosition.get(start + offset)!),
      ),
    });
    start = end;
  }
  return runs.sort((a, b) => a.position - b.position).map((run) => run.text);
}

/** The drawn width of `value`: the sum of its runs' widths, each shaped on its own. */
export function bidiTextWidth(
  font: PDFFont,
  value: string,
  size: number,
  direction: TextDirection = "auto",
): number {
  return pdfTextRuns(value, direction).reduce(
    (sum, run) => sum + font.widthOfTextAtSize(run, size),
    0,
  );
}
