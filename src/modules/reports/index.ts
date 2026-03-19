// ============================================================================
// Reports Module - Barrel Export
// ============================================================================

// Services
export {
  getFinancialReport,
  exportRegistrations,
  getEventAnalytics,
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
  type EventAnalyticsResponse,
  type AnalyticsStatusItem,
  type AnalyticsAccessItem,
} from "./analytics.schemas.js";

// Routes
export { reportsRoutes } from "./reports.routes.js";
