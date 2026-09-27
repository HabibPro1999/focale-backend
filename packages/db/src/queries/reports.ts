// ============================================================================
// Reports Module — DB query layer (read-only)
//
// Every fn here is a pure data fetch (no writes — the legacy reports module was
// entirely read-only; READ COMMITTED default is fine). File exports read their
// small header data (event, access items, counts, sort keys) through an
// optional executor, so the API runs them inside withExportStatementTimeout
// (sequentially: one transaction is one connection), and their rows page by
// page, one short transaction per page: keyset pages on registrations, or id
// chunks (export-pages.ts) when the order is decided in JS. The api-layer
// service/generators consume these and do all formatting/aggregation math. Raw-SQL semantics (jsonb_array_elements LATERAL, DATE() grouping,
// settled-only access breakdown) are preserved byte-for-byte via drizzle `sql`.
// ============================================================================

// Compatibility surface: preserve all existing report values, public types, and cursor helpers.
export {
  getFinancialSummaryAggregates,
  getPaymentStatusBreakdown,
  getAccessBreakdown,
  getDailyTrendRows,
  getEventAnalyticsData,
  getAccessRegistrantsData,
  getEventSlug,
} from "./reports/analytics";
export type {
  DateRange,
  FinancialCurrencyRow,
  FinancialSummaryAggregates,
  PaymentStatusBreakdownRow,
  AccessBreakdownRow,
  DailyTrendRow,
  EventAnalyticsData,
  AccessRegistrantRow,
  AccessRegistrantsData,
} from "./reports/analytics";
export {
  registrationsAfter,
  registrationsAfterAscending,
  iterateRegistrationsForExport,
  getRegistrationFormDataKeys,
  getRegistrationTableColumns,
  getEventAccessNames,
  getEventSlugAndName,
  iterateRegistrationsForModularExport,
  getSponsorshipLabDetails,
  getEventSummaryData,
  getReportEventAndAccess,
  iterateAccessRegistrantsForReport,
  getSponsorshipsReportData,
  iterateSponsorshipsForReport,
  iterateCheckInReportRows,
  EXPORT_PAGE_SIZE,
} from "./reports/exports";
export type {
  ExportRegistrationRow,
  RegistrationExportCursor,
  RegistrationFormColumn,
  RegistrationTableColumns,
  EventAccessNameRow,
  ModularTransactionRow,
  ModularAccessCheckInRow,
  ModularRegistrationRow,
  ModularExportOptions,
  SponsorshipLabDetail,
  EventSummaryData,
  ReportEventAndAccess,
  AccessRegistrantReportRow,
  SponsorshipReportUsage,
  SponsorshipReportRow,
  SponsorshipReportKey,
  SponsorshipsReportData,
  CheckInReportRow,
  CheckInReportScope,
  ExportPageOptions,
} from "./reports/exports";
