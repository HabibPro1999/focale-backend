import bidiFactory from "bidi-js";
import type { Color, PDFFont, PDFPage } from "pdf-lib";
const bidi=bidiFactory();

/** Visual runs retain logical Arabic text for shaping while Latin numbers remain LTR. */
export function pdfTextRuns(value:string,direction:"ltr"|"rtl"|"auto"="auto") {
  if(!value)return [];
  const embedding=bidi.getEmbeddingLevels(value,direction);
  const indices=bidi.getReorderedIndices(value,embedding);
  const visualPosition=new Map(indices.map((original,visual)=>[original,visual]));
  // Rule L4: brackets and similar pairs inside right-to-left runs take their mirrored glyph.
  const mirrored=bidi.getMirroredCharactersMap(value,embedding.levels);
  const runs:Array<{text:string;position:number}>=[];
  for(let start=0;start<value.length;) {
    let end=start+1;
    while(end<value.length&&embedding.levels[end]===embedding.levels[start])end++;
    let content="";
    for(let index=start;index<end;index++)content+=mirrored.get(index)??value[index];
    // Fontkit handles Arabic/Hebrew shaping and glyph order. Neutral-only odd runs still need reversal.
    if((embedding.levels[start]!&1)&&!/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(content))content=Array.from(content).reverse().join("");
    runs.push({text:content,position:Math.min(...Array.from({length:end-start},(_,offset)=>visualPosition.get(start+offset)!))});
    start=end;
  }
  return runs.sort((a,b)=>a.position-b.position).map(run=>run.text);
}
export function drawNetworkingText(page:PDFPage,value:string,options:{x:number;y:number;size:number;font:PDFFont;color?:Color;direction?:"ltr"|"rtl"|"auto";align?:"left"|"right";width?:number}) {
  const runs=pdfTextRuns(value,options.direction);
  const widths=runs.map(run=>options.font.widthOfTextAtSize(run,options.size));
  let x=options.x+(options.align==="right"?(options.width??0)-widths.reduce((sum,width)=>sum+width,0):0);
  for(const [index,run] of runs.entries()) {
    page.drawText(run,{x,y:options.y,font:options.font,size:options.size,color:options.color});
    x+=widths[index]!;
  }
}
