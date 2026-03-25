// ============================================================================
// Reports Module - Barrel Export
// ============================================================================

// Services
export {
  getFinancialReport,
  exportRegistrations,
  getEventAnalytics,
  generateEventSummary,
  getAccessRegistrants,
} from "./reports.service.js";

// Schemas & Types
export {
  ReportQuerySchema,
  ExportQuerySchema,
  FinancialReportResponseSchema,
  type ReportQuery,
  type ExportQuery,
  type FinancialReportResponse,
} from "./reports.schema.js";
export {
  EventAnalyticsResponseSchema,
  AccessRegistrantsResponseSchema,
  type EventAnalyticsResponse,
  type AnalyticsStatusItem,
  type AnalyticsAccessItem,
  type AccessRegistrant,
  type AccessRegistrantsResponse,
} from "./analytics.schemas.js";

// Routes
export { reportsRoutes } from "./reports.routes.js";
