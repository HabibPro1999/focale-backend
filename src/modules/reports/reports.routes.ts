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
import {
  EventAnalyticsResponseSchema,
  AccessRegistrantsResponseSchema,
} from "./analytics.schemas.js";
import {
  getFinancialReport,
  exportRegistrations,
  getEventAnalytics,
  getAccessRegistrants,
  generateEventSummary,
  generateAccessRegistrantsReport,
  generateSponsorshipsReport,
  generateCheckInReport,
} from "./reports.service.js";

// ============================================================================
// Route Registration
// ============================================================================

export async function reportsRoutes(app: AppInstance): Promise<void> {
  // All routes require authentication
  app.addHook("onRequest", requireAuth);

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
  // GET /:eventId/analytics/access-items/:accessId/registrations
  // ----------------------------------------------------------------
  app.get<{
    Params: { eventId: string; accessId: string };
  }>(
    "/:eventId/analytics/access-items/:accessId/registrations",
    {
      schema: {
        response: {
          200: AccessRegistrantsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { eventId, accessId } = request.params;

      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const data = await getAccessRegistrants(eventId, accessId);
      return reply.send(data);
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
  // GET /:eventId/reports/registrations - Export registrations (CSV/JSON)
  // ----------------------------------------------------------------
  app.get<{
    Params: { eventId: string };
    Querystring: ExportQuery;
  }>(
    "/:eventId/reports/registrations",
    {
      schema: {
        querystring: ExportQuerySchema,
      },
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
      const safeFilename = result.filename.replace(/[^a-zA-Z0-9._-]/g, "_");

      return reply
        .header("Content-Type", result.contentType)
        .header("Content-Disposition", `attachment; filename="${safeFilename}"`)
        .send(result.data);
    },
  );

  // ----------------------------------------------------------------
  // GET /:eventId/reports/access-registrants - Excel: one sheet per access item
  // ----------------------------------------------------------------
  app.get<{
    Params: { eventId: string };
  }>("/:eventId/reports/access-registrants", {}, async (request, reply) => {
    const { eventId } = request.params;

    const event = await getEventById(eventId);
    if (!event) {
      throw app.httpErrors.notFound("Event not found");
    }
    if (!canAccessClient(request.user!, event.clientId)) {
      throw app.httpErrors.forbidden("Insufficient permissions");
    }

    const result = await generateAccessRegistrantsReport(eventId);
    const safeFilename = result.filename.replace(/[^a-zA-Z0-9._-]/g, "_");

    return reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .header("Content-Disposition", `attachment; filename="${safeFilename}"`)
      .send(result.data);
  });

  // ----------------------------------------------------------------
  // GET /:eventId/reports/sponsorships - Excel: flat sponsorship export
  // ----------------------------------------------------------------
  app.get<{
    Params: { eventId: string };
  }>("/:eventId/reports/sponsorships", {}, async (request, reply) => {
    const { eventId } = request.params;

    const event = await getEventById(eventId);
    if (!event) {
      throw app.httpErrors.notFound("Event not found");
    }
    if (!canAccessClient(request.user!, event.clientId)) {
      throw app.httpErrors.forbidden("Insufficient permissions");
    }

    const result = await generateSponsorshipsReport(eventId);
    const safeFilename = result.filename.replace(/[^a-zA-Z0-9._-]/g, "_");

    return reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .header("Content-Disposition", `attachment; filename="${safeFilename}"`)
      .send(result.data);
  });

  // ----------------------------------------------------------------
  // GET /:eventId/reports/checkin-export - Download check-in ZIP
  // ----------------------------------------------------------------
  app.get<{
    Params: { eventId: string };
  }>("/:eventId/reports/checkin-export", {}, async (request, reply) => {
    const { eventId } = request.params;

    const event = await getEventById(eventId);
    if (!event) {
      throw app.httpErrors.notFound("Event not found");
    }
    if (!canAccessClient(request.user!, event.clientId)) {
      throw app.httpErrors.forbidden("Insufficient permissions");
    }

    const result = await generateCheckInReport(eventId);
    const safeFilename = result.filename.replace(/[^a-zA-Z0-9._-]/g, "_");

    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${safeFilename}"`)
      .send(result.data);
  });

  // ----------------------------------------------------------------
  // GET /:eventId/reports/summary - Download event summary report (Excel)
  // ----------------------------------------------------------------
  app.get<{
    Params: { eventId: string };
  }>("/:eventId/reports/summary", {}, async (request, reply) => {
    const { eventId } = request.params;

    const event = await getEventById(eventId);
    if (!event) {
      throw app.httpErrors.notFound("Event not found");
    }
    if (!canAccessClient(request.user!, event.clientId)) {
      throw app.httpErrors.forbidden("Insufficient permissions");
    }

    const result = await generateEventSummary(eventId);
    const safeFilename = result.filename.replace(/[^a-zA-Z0-9._-]/g, "_");

    return reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .header("Content-Disposition", `attachment; filename="${safeFilename}"`)
      .send(result.data);
  });
}
