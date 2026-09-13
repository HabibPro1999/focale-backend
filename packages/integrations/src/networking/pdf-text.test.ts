import {describe,expect,it} from "vitest";
import {pdfTextRuns} from "./pdf-text";
describe("mixed-direction PDF text",()=>{
 it("keeps years and counts in logical digit order inside Arabic lines",()=>{
  const runs=pdfTextRuns("تاريخ الإنشاء: 8 سبتمبر 2026","rtl");
  expect(runs).toContain("2026");
  expect(runs.join("")).not.toContain("6202");
  expect(runs.some(run=>run.includes("تاريخ"))).toBe(true);
 });
 it("preserves Latin company names and numeric values in Arabic sections",()=>{
  const runs=pdfTextRuns("Santé: 48 العلاقات","rtl");
  expect(runs.some(run=>run.includes("Santé"))).toBe(true);
  expect(runs.some(run=>run.includes("48"))).toBe(true);
 });
});
