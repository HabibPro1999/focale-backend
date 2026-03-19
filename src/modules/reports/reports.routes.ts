// ============================================================================
// Reports Module - Routes (Protected)
// ============================================================================

import type { AppInstance } from "@shared/types/fastify.js";
import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { getEventById } from "@events";
import {
  ReportQuerySchema,
  ExportQuerySchema,
  FinancialReportResponseSchema,
  type ReportQuery,
  type ExportQuery,
} from "./reports.schema.js";
import { EventAnalyticsResponseSchema } from "./analytics.schemas.js";
import {
  getFinancialReport,
  exportRegistrations,
  getEventAnalytics,
} from "./reports.service.js";

// ============================================================================
// Route Registration
// ============================================================================

export async function reportsRoutes(app: AppInstance): Promise<void> {
  // ----------------------------------------------------------------
  // GET /:eventId/analytics - Get event analytics dashboard data
  // ----------------------------------------------------------------
  app.get<{
    Params: { eventId: string };
  }>(
    "/:eventId/analytics",
    {
      schema: {
        response: {
          200: EventAnalyticsResponseSchema,
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { eventId } = request.params;

      // Authorization: verify client access
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const analytics = await getEventAnalytics(eventId);
      return reply.send(analytics);
    },
  );

  // ----------------------------------------------------------------
  // GET /:eventId/reports/financial - Get financial report
  // ----------------------------------------------------------------
  app.get<{
    Params: { eventId: string };
    Querystring: ReportQuery;
  }>(
    "/:eventId/reports/financial",
    {
      schema: {
        querystring: ReportQuerySchema,
        response: {
          200: FinancialReportResponseSchema,
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { eventId } = request.params;

      // Authorization: verify client access
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const report = await getFinancialReport(eventId, request.query);
      return reply.send(report);
    },
  );

  // ----------------------------------------------------------------
  // GET /:eventId/reports/export - Export registrations
  // ----------------------------------------------------------------
  app.get<{
    Params: { eventId: string };
    Querystring: ExportQuery;
  }>(
    "/:eventId/reports/export",
    {
      schema: {
        querystring: ExportQuerySchema,
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { eventId } = request.params;

      // Authorization: verify client access
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const result = await exportRegistrations(eventId, request.query);

      return reply
        .header("Content-Type", result.contentType)
        .header(
          "Content-Disposition",
          `attachment; filename="${result.filename}"`,
        )
        .send(result.data);
    },
  );
}
