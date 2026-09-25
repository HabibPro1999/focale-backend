// =============================================================================
// PDF FONTS
// Unicode fonts for every server-generated PDF (certificates, the Abstract
// Book, networking reports). The pdf-lib standard fonts only encode WinAnsi, so
// Greek, math symbols, Arabic or Hebrew need an embedded TrueType font. Font
// files are read once per process and cached; each document embeds (and by
// default subsets) its own copy.
// =============================================================================

import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import type { PDFDocument, PDFFont } from "pdf-lib";

/** Bundled DejaVu faces (package `dejavu-fonts-ttf`). */
export type DejaVuFace =
  | "DejaVuSans.ttf"
  | "DejaVuSans-Bold.ttf"
  | "DejaVuSerif.ttf"
  | "DejaVuSerif-Bold.ttf"
  | "DejaVuSansMono.ttf"
  | "DejaVuSansMono-Bold.ttf";

export function dejaVuFontPath(face: DejaVuFace): string {
  return require.resolve(`dejavu-fonts-ttf/ttf/${face}`);
}

const fontBytesCache = new Map<string, Promise<Uint8Array>>();

/** Font file bytes, read once per process (a failed read is retried next time). */
export function loadFontBytes(path: string): Promise<Uint8Array> {
  let bytes = fontBytesCache.get(path);
  if (!bytes) {
    bytes = readFile(path);
    fontBytesCache.set(path, bytes);
    bytes.catch(() => fontBytesCache.delete(path));
  }
  return bytes;
}

/** Embed a TrueType/OpenType font file into `doc` (subset by default). */
export async function embedFontFile(
  doc: PDFDocument,
  path: string,
  options: { subset?: boolean } = {},
): Promise<PDFFont> {
  doc.registerFontkit(fontkit);
  return doc.embedFont(await loadFontBytes(path), {
    subset: options.subset ?? true,
  });
}

/** Embed a bundled DejaVu face into `doc` (subset by default). */
export function embedDejaVuFont(
  doc: PDFDocument,
  face: DejaVuFace,
  options: { subset?: boolean } = {},
): Promise<PDFFont> {
  return embedFontFile(doc, dejaVuFontPath(face), options);
}
