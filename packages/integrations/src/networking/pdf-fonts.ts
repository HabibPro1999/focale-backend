import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument } from "pdf-lib";

export function embedDejaVuFonts(document: PDFDocument, styles: readonly ("regular" | "bold")[]) {
  document.registerFontkit(fontkit);
  return Promise.all(styles.map(async (style) => document.embedFont(
    await readFile(require.resolve(`dejavu-fonts-ttf/ttf/${style === "bold" ? "DejaVuSans-Bold.ttf" : "DejaVuSans.ttf"}`)),
    { subset: true },
  )));
}
