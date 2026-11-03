import type { Color, PDFFont, PDFPage } from "pdf-lib";
import { pdfTextRuns } from "../pdf/bidi-text";

export { pdfTextRuns };

export function drawNetworkingText(page:PDFPage,value:string,options:{x:number;y:number;size:number;font:PDFFont;color?:Color;direction?:"ltr"|"rtl"|"auto";align?:"left"|"right";width?:number}) {
  const runs=pdfTextRuns(value,options.direction);
  const widths=runs.map(run=>options.font.widthOfTextAtSize(run,options.size));
  let x=options.x+(options.align==="right"?(options.width??0)-widths.reduce((sum,width)=>sum+width,0):0);
  for(const [index,run] of runs.entries()) {
    page.drawText(run,{x,y:options.y,font:options.font,size:options.size,color:options.color});
    x+=widths[index]!;
  }
}
