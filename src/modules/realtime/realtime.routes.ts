import { z } from "zod";
import { requireAuth } from "@shared/middleware/auth.middleware.js";
import { UserRole } from "@shared/constants/roles.js";
import { config } from "@config/app.config.js";
import { eventBus, type AppEventHandler } from "@core/events/bus.js";
import type { AppEvent } from "@core/events/types.js";
import type { AppInstance } from "@shared/types/fastify.js";

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
        // SSE holds one long connection, not rapid requests — give headroom
        // for reconnect storms on flaky networks without blocking legitimate
        // retries.
        rateLimit: { max: 60, timeWindow: "1 minute" },
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

      const matches = (ev: AppEvent): boolean => {
        if (ev.clientId !== scopedClientId) return false;
        if (eventId && ev.eventId && ev.eventId !== eventId) return false;
        return true;
      };

      const sendFrame = (id: string, ev: AppEvent) => {
        if (!reply.sse.isConnected) return;
        reply.sse.send({ id, data: ev }).catch(() => {
          /* client disconnected mid-write */
        });
      };

      const handler: AppEventHandler = (ev, id) => {
        if (!matches(ev)) return;
        sendFrame(id, ev);
      };

      const close = () => {
        eventBus.off(handler);
        try {
          reply.sse.close();
        } catch {
          // already closed
        }
      };

      // Subscribe before replaying so live events that land during replay
      // still reach the client (id stays monotonic — order is preserved).
      eventBus.on(handler);
      activeConnections.add(close);

      reply.sse.onClose(() => {
        eventBus.off(handler);
        activeConnections.delete(close);
      });

      // Replay events after Last-Event-ID. fetch-event-source sets this
      // header automatically on reconnect when the previous stream emitted
      // `id:` frames. Closes the gap window caused by proxy drops, deploys,
      // tab-switches, or network blips.
      const lastEventId = request.headers["last-event-id"];
      if (typeof lastEventId === "string" && lastEventId.length > 0) {
        const buffered = eventBus.getSince(lastEventId);
        for (const { id, ev } of buffered) {
          if (matches(ev)) sendFrame(id, ev);
        }
      }

      await reply.sse.send({
        event: "ready",
        retry: config.realtime.clientRetryMs,
        data: { scopedClientId, eventId: eventId ?? null },
      });
    },
  );
}
