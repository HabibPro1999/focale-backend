import { Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { UserRole, type AppEvent } from "@app/contracts";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { CONFIG, type Config } from "../../core/config";
import type { AuthUser } from "../../core/auth/user-cache";
import { eventBus, type AppEventHandler } from "./bus";
import { RealtimeConnectionRegistry } from "./connections";
import { SseStream } from "./sse";
import { StreamQueryDto } from "./realtime.dto";

/**
 * GET /api/stream — the single realtime SSE endpoint. Pure pub/sub relay over
 * the in-process event bus; zero DB access. Scoping depends on query params, so
 * it implements its own client scoping inline rather than reusing the shared
 * role helpers. Ported from the legacy `src/modules/realtime/realtime.routes.ts`.
 *
 * Rate limit is a route-level override (60/min): an SSE client holds one long
 * connection, so this covers reconnect storms, not steady traffic.
 */
@Auth()
@Controller()
export class RealtimeController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly registry: RealtimeConnectionRegistry,
  ) {}

  @Get("api/stream")
  @SkipEnvelope()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async stream(
    @CurrentUser() user: AuthUser,
    @Query() query: StreamQueryDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (this.config.realtime.disabled) {
      await reply.status(503).send({ error: "Realtime disabled" });
      return;
    }

    const { eventId, clientId: clientIdQuery } = query as {
      eventId?: string;
      clientId?: string;
    };

    // Scope: client admin forced to own clientId; super admin must pass ?clientId.
    let scopedClientId: string;
    if (user.role === UserRole.CLIENT_ADMIN) {
      if (!user.clientId) {
        await reply.status(403).send({ error: "No client scope" });
        return;
      }
      // A ?clientId query param is silently ignored for client admins.
      scopedClientId = user.clientId;
    } else if (user.role === UserRole.SUPER_ADMIN) {
      if (!clientIdQuery) {
        // Super admin without a client: upgrade to SSE, emit one scope-required
        // frame, then close. No bus listener is ever registered for this case.
        reply.hijack();
        const sse = new SseStream(reply);
        await sse.send({
          event: "scope-required",
          data: { error: "super_admin must provide ?clientId" },
        });
        sse.close();
        return;
      }
      scopedClientId = clientIdQuery;
    } else {
      await reply.status(403).send({ error: "Forbidden" });
      return;
    }

    reply.hijack();
    const sse = new SseStream(reply);
    sse.keepAlive(this.config.realtime.heartbeatMs);

    const matches = (ev: AppEvent): boolean => {
      if (ev.clientId !== scopedClientId) return false;
      if (eventId && ev.eventId !== eventId) return false;
      return true;
    };

    let closed = false;
    let close: () => void = () => {
      closed = true;
    };

    const sendFrame = (id: string, ev: AppEvent): void => {
      if (closed || !sse.isConnected) return;
      sse.send({ id, data: ev }).catch(() => {
        close();
      });
    };

    const handler: AppEventHandler = (ev, id) => {
      if (!matches(ev)) return;
      sendFrame(id, ev);
    };

    close = () => {
      if (closed) return;
      closed = true;
      eventBus.off(handler);
      this.registry.remove(close);
      try {
        sse.close();
      } catch {
        // already closed
      }
    };

    // Replay after Last-Event-ID (set by fetch-event-source on reconnect).
    // Drained from the buffer snapshot BEFORE subscribing, so no double-delivery
    // or dropped-event window.
    const lastEventId = req.headers["last-event-id"];
    if (typeof lastEventId === "string" && lastEventId.length > 0) {
      if (eventBus.hasReplayGap(lastEventId)) {
        await sse.send({ event: "replay-gap", data: { lastEventId } });
      }
      const buffered = eventBus.getSince(lastEventId);
      for (const { id, ev } of buffered) {
        if (matches(ev)) sendFrame(id, ev);
      }
    }

    eventBus.on(handler);
    this.registry.add(close);
    sse.onClose(close);

    await sse.send({
      event: "ready",
      retry: this.config.realtime.clientRetryMs,
      data: { scopedClientId, eventId: eventId ?? null },
    });
  }
}
