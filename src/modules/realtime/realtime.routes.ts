import { z } from "zod";
import { requireAuth } from "@shared/middleware/auth.middleware.js";
import { UserRole } from "@shared/constants/roles.js";
import { config } from "@config/app.config.js";
import { eventBus, type AppEventHandler } from "@core/events/bus.js";
import type { AppEvent } from "@core/events/types.js";
import type { AppInstance } from "@shared/types/fastify.js";
import { logger } from "@shared/utils/logger.js";

const QuerySchema = z.object({
  eventId: z.string().optional(),
  clientId: z.string().optional(),
});

/**
 * Tracks active SSE connections so we can drain on graceful shutdown.
 */
const activeConnections = new Set<() => void>();

export function drainRealtimeConnections(): void {
  for (const close of activeConnections) {
    try {
      close();
    } catch {
      // best-effort drain
    }
  }
  activeConnections.clear();
}

export async function realtimeRoutes(app: AppInstance): Promise<void> {
  app.get(
    "/stream",
    {
      onRequest: [requireAuth],
      schema: { querystring: QuerySchema },
      sse: true,
      config: {
        // Per-route rate limit override: SSE is one long connection, not a flood
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      if (config.realtime.disabled) {
        return reply.status(503).send({ error: "Realtime disabled" });
      }

      const user = request.user!;
      const { eventId, clientId: clientIdQuery } = request.query as z.infer<
        typeof QuerySchema
      >;

      // Scope: client admin forced to own clientId; super admin must pass ?clientId
      let scopedClientId: string;
      if (user.role === UserRole.CLIENT_ADMIN) {
        if (!user.clientId) {
          return reply.status(403).send({ error: "No client scope" });
        }
        scopedClientId = user.clientId;
      } else if (user.role === UserRole.SUPER_ADMIN) {
        if (!clientIdQuery) {
          await reply.sse.send({
            event: "scope-required",
            data: { error: "super_admin must provide ?clientId" },
          });
          reply.sse.close();
          return;
        }
        scopedClientId = clientIdQuery;
      } else {
        return reply.status(403).send({ error: "Forbidden" });
      }

      reply.sse.keepAlive();

      const handler: AppEventHandler = (ev: AppEvent) => {
        const scopeMatch = ev.clientId === scopedClientId;
        const eventMatch = !eventId || !ev.eventId || ev.eventId === eventId;
        logger.info(
          {
            type: ev.type,
            evClientId: ev.clientId,
            evEventId: ev.eventId,
            scopedClientId,
            filterEventId: eventId ?? null,
            scopeMatch,
            eventMatch,
            connected: reply.sse.isConnected,
          },
          "[realtime] handler received",
        );
        if (!scopeMatch) return;
        if (!eventMatch) return;
        if (!reply.sse.isConnected) {
          logger.warn(
            { scopedClientId, type: ev.type },
            "[realtime] skipped — connection not connected",
          );
          return;
        }
        // Fire-and-forget; plugin serializes writes internally
        reply.sse
          .send({ data: ev })
          .then(() =>
            logger.info(
              { type: ev.type, scopedClientId },
              "[realtime] sent to client",
            ),
          )
          .catch((err) =>
            logger.warn(
              { err: String(err), type: ev.type, scopedClientId },
              "[realtime] send failed",
            ),
          );
      };

      const close = () => {
        eventBus.off(handler);
        try {
          reply.sse.close();
        } catch {
          // already closed
        }
      };

      eventBus.on(handler);
      activeConnections.add(close);

      reply.sse.onClose(() => {
        eventBus.off(handler);
        activeConnections.delete(close);
      });

      // Send initial hello + retry hint after subscription is in place
      await reply.sse.send({
        event: "ready",
        retry: config.realtime.clientRetryMs,
        data: { scopedClientId, eventId: eventId ?? null },
      });
    },
  );
}
