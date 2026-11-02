import { drawNetworkingText } from "./networking/pdf-text";
import { PDFDocument, rgb } from "pdf-lib";
import { embedDejaVuFont } from "./pdf-fonts";
/** Paginated UTF-8 report; each record is printed in full without truncation. */
export async function generateNetworkingReportPdf(
  title: string,
  headers: string[],
  rows: unknown[][],
): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await embedDejaVuFont(document, "DejaVuSans.ttf");
  let page = document.addPage([595.28, 841.89]);
  let y = 790;
  let pageNumber = 1;
  const newPage = () => {
    page.drawText(String(pageNumber++), { x: 550, y: 24, font, size: 8 });
    page = document.addPage([595.28, 841.89]);
    y = 790;
  };
  const line = (value: string, size = 10) => {
    let remaining = value;
    while (remaining.length) {
      const characters = Array.from(remaining);
      let lower = 1,
        upper = characters.length;
      while (lower < upper) {
        const midpoint = Math.ceil((lower + upper) / 2);
        if (
          font.widthOfTextAtSize(
            characters.slice(0, midpoint).join(""),
            size,
          ) <= 505
        )
          lower = midpoint;
        else upper = midpoint - 1;
      }
      let take = characters.slice(0, lower).join("").length;
      if (take < remaining.length) {
        const space = remaining.lastIndexOf(" ", take);
        if (space > take / 2) take = space;
      }
      if (y < 55) newPage();
      drawNetworkingText(page, remaining.slice(0, take), {
        x: 45,
        y,
        font,
        size,
        color: rgb(0.08, 0.12, 0.2),
      });
      y -= size + 5;
      remaining = remaining.slice(take).trimStart();
    }
  };
  line(title, 18);
  line(`${rows.length} records • ${new Date().toISOString().slice(0, 10)}`, 9);
  y -= 16;
  for (let index = 0; index < rows.length; index++) {
    if (y < 110) newPage();
    line(`${index + 1}.`, 11);
    for (let column = 0; column < headers.length; column++)
      for (const text of `${headers[column]}: ${String(rows[index][column] ?? "")}`.split(
        /\r?\n/,
      ))
        line(text);
    y -= 13;
  }
  page.drawText(String(pageNumber), { x: 550, y: 24, font, size: 8 });
  return Buffer.from(await document.save());
}
