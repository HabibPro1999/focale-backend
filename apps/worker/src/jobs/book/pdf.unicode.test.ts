import { describe, expect, it } from "vitest";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
} from "pdf-lib";
import type { AbstractBookData } from "@app/db";
import { generateAbstractBookPdf } from "./pdf";

// Test-only text extraction, the way a PDF viewer copies or searches text:
// every shown glyph is mapped back to Unicode through its font's ToUnicode
// CMap. Text a viewer cannot map (a missing ToUnicode entry) comes out as
// U+FFFD; text the renderer replaced with "?" comes out as "?". Each Tj/TJ
// operator becomes one chunk, in drawing order.

function streamText(stream: unknown): string {
  if (!(stream instanceof PDFRawStream)) return "";
  return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
}

function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/\s+/g, "");
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) bytes.push(parseInt(padded.slice(i, i + 2), 16));
  return bytes;
}

function utf16HexToString(hex: string): string {
  const bytes = hexToBytes(hex);
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  }
  return out;
}

/** CID (hex) → Unicode from a ToUnicode CMap (bfchar and bfrange). */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(src!, 16), utf16HexToString(dst!));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dst] of block[1]!.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
    )) {
      const base = utf16HexToString(dst!);
      for (let cid = parseInt(lo!, 16); cid <= parseInt(hi!, 16); cid++) {
        const offset = cid - parseInt(lo!, 16);
        map.set(cid, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + offset));
      }
    }
  }
  return map;
}

interface FontDecoder {
  bytesPerCode: number;
  toUnicode: Map<number, string> | null;
}

function fontDecoders(doc: PDFDocument, resources: PDFDict | undefined): Map<string, FontDecoder> {
  const decoders = new Map<string, FontDecoder>();
  const fonts = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
  if (!fonts) return decoders;
  for (const [name, ref] of fonts.entries()) {
    const font = doc.context.lookup(ref, PDFDict);
    const subtype = font.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
    const toUnicodeRef = font.get(PDFName.of("ToUnicode"));
    const toUnicode =
      toUnicodeRef instanceof PDFRef
        ? parseToUnicode(streamText(doc.context.lookup(toUnicodeRef)))
        : null;
    decoders.set(name.asString(), {
      bytesPerCode: subtype === "/Type0" ? 2 : 1,
      toUnicode,
    });
  }
  return decoders;
}

function decodeString(bytes: number[], decoder: FontDecoder | undefined): string {
  if (!decoder) return "�";
  let out = "";
  for (let i = 0; i < bytes.length; i += decoder.bytesPerCode) {
    const code = decoder.bytesPerCode === 2 ? (bytes[i]! << 8) | (bytes[i + 1] ?? 0) : bytes[i]!;
    if (decoder.toUnicode) out += decoder.toUnicode.get(code) ?? "�";
    else out += String.fromCharCode(code); // simple font: WinAnsi ≈ Latin-1
  }
  return out;
}

function literalBytes(literal: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < literal.length; i++) {
    const char = literal[i]!;
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0));
      continue;
    }
    const next = literal[++i]!;
    const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
    if (next in escapes) bytes.push(escapes[next]!);
    else if (/[0-7]/.test(next)) {
      const octal = literal.slice(i, i + 3).match(/^[0-7]{1,3}/)![0];
      bytes.push(parseInt(octal, 8));
      i += octal.length - 1;
    }
  }
  return bytes;
}

/** Text chunks of every page, in drawing order. */
async function extractPdfText(pdf: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf);
  const chunks: string[] = [];
  for (const page of doc.getPages()) {
    const decoders = fontDecoders(doc, page.node.Resources());
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => doc.context.lookup(ref))
        : [contents];
    let font: FontDecoder | undefined;
    for (const stream of streams) {
      const content = streamText(stream);
      const tokens = content.matchAll(
        /\/([^\s/<>[\]()]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj|\[([^\]]*)\]\s*TJ/g,
      );
      for (const [, fontName, hex, literal, array] of tokens) {
        if (fontName) font = decoders.get(`/${fontName}`);
        else if (hex !== undefined) chunks.push(decodeString(hexToBytes(hex), font));
        else if (literal !== undefined) chunks.push(decodeString(literalBytes(literal), font));
        else if (array !== undefined) {
          let text = "";
          for (const [, h, l] of array.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g)) {
            text += decodeString(h !== undefined ? hexToBytes(h) : literalBytes(l!), font);
          }
          chunks.push(text);
        }
      }
    }
  }
  return chunks;
}

function book(overrides: Partial<AbstractBookData["config"]> = {}): AbstractBookData {
  const abstract = {
    id: "abs-1",
    code: "A-001",
    codeNumber: 1,
    finalType: "ORAL_COMMUNICATION",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    authorFirstName: "محمد",
    authorLastName: "العربي",
    authorAffiliation: "Université de Tunis",
    authorEmail: "m.arabi@example.com",
    coAuthors: [{ firstName: "Ελένη", lastName: "Παπαδοπούλου", affiliation: "Αθήνα" }],
    content: {
      title: "Effect of β-blockers when eGFR ≤ 30 mL/min",
      mode: "FREE_TEXT",
      body: "<p>Patients with α ≥ 2 and κ ≤ 0.5 were included (n = 42). ΔHbA1c −0.8%.</p>",
    },
    additionalFieldsData: {},
    themes: [],
  };
  return {
    eventName: "Congrès — Cardiologie 2026",
    config: {
      bookFontFamily: "Helvetica",
      bookFontSize: 10,
      bookLineSpacing: 1.3,
      bookOrder: "BY_CODE",
      bookIncludeAuthorNames: true,
      additionalFieldsSchema: [],
      ...overrides,
    },
    abstracts: [abstract],
  } as unknown as AbstractBookData;
}

/** Extracted text with the Arabic presentation forms a viewer returns normalised. */
async function bookText(data: AbstractBookData): Promise<string> {
  const { buffer } = await generateAbstractBookPdf(data);
  return (await extractPdfText(buffer)).join(" ").replace(/\s+/g, " ").normalize("NFKC");
}

describe("Abstract Book — non-Latin-1 text (6.2)", () => {
  it.each(["Helvetica", "Times New Roman", "Courier"])(
    "keeps Greek, ≤ and an Arabic author name extractable (%s)",
    async (bookFontFamily) => {
      const text = await bookText(book({ bookFontFamily }));

      expect(text).not.toContain("?");
      expect(text).not.toContain("\uFFFD");
      expect(text).toContain("β-blockers when eGFR ≤ 30 mL/min");
      expect(text).toContain("α ≥ 2 and κ ≤ 0.5");
      expect(text).toContain("ΔHbA1c −0.8%");
      expect(text).toContain("Ελένη Παπαδοπούλου");
      expect(text).toContain("Congrès — Cardiologie 2026");
      // Arabic is stored in visual (right-to-left) glyph order, as in any PDF;
      // every letter of the name maps back to its character.
      for (const word of ["محمد", "العربي"]) {
        const logical = text.includes(word);
        const visual = text.includes(Array.from(word).reverse().join(""));
        expect(logical || visual, word).toBe(true);
      }
    },
  );

  it("still renders the book when a character has no glyph in any bundled font", async () => {
    const data = book();
    data.abstracts[0]!.content = { title: "東京 study 🎉", mode: "FREE_TEXT", body: "ok" };

    const text = await bookText(data);

    expect(text).toContain("study");
    expect(text).not.toContain("?");
  });
});
