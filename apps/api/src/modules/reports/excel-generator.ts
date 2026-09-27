// =============================================================================
// Report workbooks (summary, access registrants, sponsorships, check-in ZIP),
// one module each under ./generators. Each `prepare*` reads the report's small
// header data (event, access items, counts or sort keys) and returns an
// ExportDownload whose `write` streams the workbook: ExcelJS's streaming
// writer, rows read page by page and committed one at a time, paced by the zip
// and the client. The check-in ZIP writes each workbook to a temp file, then
// streams a stored ZIP of them.
// =============================================================================

export { prepareEventSummary } from "./generators/event-summary";
export { prepareAccessRegistrantsReport } from "./generators/access-registrants";
export { prepareSponsorshipsReport } from "./generators/sponsorships";
export { prepareCheckInReport } from "./generators/checkin-zip";
