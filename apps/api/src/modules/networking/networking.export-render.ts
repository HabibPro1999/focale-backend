import ExcelJS from "exceljs";
import { generateNetworkingReportPdf } from "@app/integrations";
import { csvCell } from "./networking.policy";

export const csv = (headers: string[], rows: unknown[][]) =>
  "\uFEFF" +
  [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");

export async function renderNetworkingTable(format: string, title: string, sheetName: string, headers: string[], rows: unknown[][]) {
  if (format === "csv")
    return {
      body: csv(headers, rows),
      contentType: "text/csv; charset=utf-8",
    };
  if (format === "pdf")
    return {
      body: await generateNetworkingReportPdf(
        title,
        headers,
        rows,
      ),
      contentType: "application/pdf",
    };
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Focale";
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row.map((value) => value ?? ""));
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1E3A5F" },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: rows.length + 1, column: headers.length },
  };
  sheet.columns.forEach((column) => {
    column.width = 24;
    column.alignment = { wrapText: true, vertical: "top" };
  });
  return {
    body: Buffer.from(await workbook.xlsx.writeBuffer()),
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}
