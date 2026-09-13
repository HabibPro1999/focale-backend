import { describe,expect,it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { generateNetworkingPostEventPdf,networkingReportObservations,type NetworkingReportSnapshot } from "./post-event-pdf";
const snapshot:NetworkingReportSnapshot={summary:{participants:120,active_participants:84,connections:93,messages:218,meetings:36,completed_meetings:29,no_shows:3,conversations:66,responsive_conversations:42},sectors:[{sector:"Santé",participants:55,connections:48,meetings:20},{sector:"Investissement",participants:35,connections:31,meetings:11},{sector:"Énergie",participants:30,connections:14,meetings:5}],timeSeries:[{date:"2030-05-01",connections:25,messages:64,meetings:10},{date:"2030-05-02",connections:43,messages:99,meetings:16},{date:"2030-05-03",connections:25,messages:55,meetings:10}]};
describe("post-event report",()=>{
 it.each(["fr","en","ar"] as const)("renders a standalone paginated %s report with charts",async language=>{
  const pdf=await generateNetworkingPostEventPdf(language==="ar"?"ملتقى الأعمال":"Focale Business Connections",snapshot,language);
  const document=await PDFDocument.load(pdf);
  expect(document.getPageCount()).toBeGreaterThanOrEqual(2);
  expect(document.getPageCount()).toBeLessThan(6);
  expect(pdf.length).toBeGreaterThan(10000);
 });
 it("does not invent an attendance result when no attendance was recorded",()=>{
  const notes=networkingReportObservations({summary:{participants:10,active_participants:2,connections:0,messages:0,meetings:4,completed_meetings:0,no_shows:0},sectors:[]},"en");
  expect(notes).toContain("Meeting attendance was not recorded; completion rates cannot be established.");
  expect(notes.some(note=>note.includes("revenue"))).toBe(false);
 });
});
