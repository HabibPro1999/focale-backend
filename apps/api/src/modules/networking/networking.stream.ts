import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  networkingNotificationsPage,
  setNetworkingNoticePublisher,
  type NetworkingNotice,
} from "@app/db";
import { CONFIG, type Config } from "../../core/config";
import { logger } from "../../core/logger.service";
import {
  networkingNotificationHub,
  type NetworkingNotificationHub,
} from "../../core/networking-notification-hub";
import { ShutdownCoordinator } from "../../core/shutdown";
import { SseStream, type SseFrame } from "../realtime/sse";
import { NetworkingService, type NetworkingContext } from "./networking.service";

/** Participant stream limits (plan 4.3). */
export const NETWORKING_STREAM = {
  /** Open streams per participant session; a newer one replaces the oldest. */
  maxPerSession: 3,
  /** Catch-up without a signal: covers any notice the hub never got. */
  resyncMs: 60_000,
  /** How often the session, eligibility and event window are re-checked. */
  sessionCheckMs: 5 * 60_000,
  /** A stream ends after at most this long; the client resumes with Last-Event-ID. */
  lifetimeMs: 30 * 60_000,
  /** Lifetimes are shortened by up to this much, so reconnects spread out. */
  lifetimeJitterMs: 2 * 60_000,
  /** Each catch-up re-reads this far behind its watermark (late commits, clock skew). */
  overlapMs: 10_000,
  /** Keyset page size of the catch-up query, and rows per `notifications` frame. */
  pageSize: 100,
  /** Ids already sent on this stream (bounded; the overlap window is small). */
  sentMemory: 1_000,
  /** A Last-Event-ID older than this is not replayed (`replay-gap`: refetch the list). */
  maxResumeAgeMs: 24 * 60 * 60_000,
  /** A Last-Event-ID this far in the future is not ours. */
  maxResumeSkewMs: 60_000,
} as const;

type NotificationRow = Awaited<ReturnType<typeof networkingNotificationsPage>>[number];

/**
 * The stream's SSE id is a watermark (ms since epoch): every notification
 * created before `watermark − overlap` has been sent. Only digits are ours.
 */
export function parseNetworkingStreamCursor(value: string, now: number): number | null {
  if (!/^\d{1,16}$/.test(value)) return null;
  const at = Number(value);
  if (at > now + NETWORKING_STREAM.maxResumeSkewMs) return null;
  if (at < now - NETWORKING_STREAM.maxResumeAgeMs) return null;
  return at;
}

export interface ParticipantStreamDeps {
  hub: Pick<NetworkingNotificationHub, "subscribe">;
  lifecycle: Pick<ShutdownCoordinator, "trackStream">;
  readPage: typeof networkingNotificationsPage;
  /** Re-resolves the participant from the stream's bearer; throws like any participant route. */
  checkSession: () => Promise<NetworkingContext>;
  heartbeatMs: number;
  clientRetryMs: number;
  now?: () => number;
  random?: () => number;
}

/**
 * One participant's notification stream. The hub (or the periodic resync)
 * wakes it; it then runs a keyset catch-up over its own participant's rows,
 * from its watermark minus the overlap, and sends what this stream has not
 * sent yet. Signals arriving during a catch-up coalesce into one more pass.
 */
export class ParticipantStream {
  private watermark: number;
  private readonly sent = new Set<string>();
  private running = false;
  private again = false;
  private ended = false;
  private readonly timers: Array<ReturnType<typeof setTimeout>> = [];
  private unsubscribe: () => void = () => undefined;
  private untrack: () => void = () => undefined;
  private readonly endCallbacks: Array<() => void> = [];
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly sse: SseStream,
    private ctx: NetworkingContext,
    private readonly deps: ParticipantStreamDeps,
    private readonly resume: { at: number | null; gap: string | null },
  ) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.watermark = resume.at ?? this.now();
  }

  get sessionId(): string {
    return this.ctx.session.id;
  }

  get isOpen(): boolean {
    return !this.ended;
  }

  onEnd(callback: () => void): void {
    this.endCallbacks.push(callback);
  }

  async start(): Promise<void> {
    const target: NetworkingNotice = { eventId: this.ctx.event.id, profileId: this.ctx.profile.id };
    // Subscribe before the first catch-up reads, so no notice falls between.
    this.unsubscribe = this.deps.hub.subscribe(target, () => this.requestCatchUp());
    // Shutdown drain (ShutdownCoordinator): tell the client when to reconnect, then close.
    this.untrack = this.deps.lifecycle.trackStream((reconnectInMs) =>
      this.end({ event: "shutdown", retry: reconnectInMs, data: { reconnectInMs } }),
    );
    this.sse.onClose(() => this.end());
    this.sse.keepAlive(this.deps.heartbeatMs);

    const every = (ms: number, run: () => void) => {
      const timer = setInterval(run, ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(NETWORKING_STREAM.resyncMs, () => this.requestCatchUp());
    every(NETWORKING_STREAM.sessionCheckMs, () => void this.checkSession());
    const lifetime = setTimeout(
      () => this.end({ event: "reconnect", data: { reason: "lifetime" } }),
      NETWORKING_STREAM.lifetimeMs - Math.floor(this.random() * NETWORKING_STREAM.lifetimeJitterMs),
    );
    lifetime.unref?.();
    this.timers.push(lifetime);

    try {
      await this.sse.send({
        id: String(this.watermark),
        event: "ready",
        retry: this.deps.clientRetryMs,
        data: {},
      });
      if (this.resume.gap !== null)
        await this.sse.send({ event: "replay-gap", data: { lastEventId: this.resume.gap } });
    } catch {
      this.end();
      return;
    }
    this.requestCatchUp();
  }

  /** Coalesce: one catch-up at a time, plus one more if woken meanwhile. */
  requestCatchUp(): void {
    if (this.ended) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
    });
  }

  private async drain(): Promise<void> {
    do {
      this.again = false;
      try {
        await this.catchUp();
      } catch (err) {
        if (this.ended) return;
        logger.warn({ err, eventId: this.ctx.event.id }, "Networking stream catch-up failed; client will resume");
        this.end({ event: "reconnect", data: { reason: "error" } });
        return;
      }
    } while (this.again && !this.ended);
  }

  /**
   * Keyset catch-up: every row of this participant created at or after
   * `watermark − overlap`, paged by id, minus what this stream already sent.
   * The watermark then moves to when this pass started, and the frames carry
   * it as their SSE id.
   */
  private async catchUp(): Promise<void> {
    const passStartedAt = this.now();
    const since = new Date(this.watermark - NETWORKING_STREAM.overlapMs);
    const fresh: NotificationRow[] = [];
    for (let afterId: string | null = null; ; ) {
      const rows = await this.deps.readPage(
        this.ctx.event.id,
        this.ctx.profile.id,
        since,
        afterId,
        NETWORKING_STREAM.pageSize,
      );
      if (this.ended) return;
      for (const row of rows) if (!this.sent.has(row.id)) fresh.push(row);
      if (rows.length < NETWORKING_STREAM.pageSize) break;
      afterId = rows[rows.length - 1]!.id;
    }
    this.watermark = passStartedAt;
    for (let i = 0; i < fresh.length; i += NETWORKING_STREAM.pageSize) {
      const chunk = fresh.slice(i, i + NETWORKING_STREAM.pageSize);
      const last = i + NETWORKING_STREAM.pageSize >= fresh.length;
      for (const row of chunk) this.remember(row.id);
      // Only the last frame of a pass advances the client's Last-Event-ID.
      await this.sse.send({ id: last ? String(passStartedAt) : undefined, event: "notifications", data: chunk });
    }
  }

  private remember(id: string): void {
    this.sent.add(id);
    if (this.sent.size > NETWORKING_STREAM.sentMemory) {
      const oldest = this.sent.values().next().value;
      if (oldest !== undefined) this.sent.delete(oldest);
    }
  }

  /** Every 5 min: the same checks as any participant request (session, eligibility, window). */
  async checkSession(): Promise<void> {
    if (this.ended) return;
    try {
      const next = await this.deps.checkSession();
      if (this.ended) return;
      if (next.session.id !== this.ctx.session.id || next.profile.id !== this.ctx.profile.id) {
        this.end({ event: "session-ended", data: { code: "NETWORKING_SESSION_EXPIRED" } });
        return;
      }
      this.ctx = next;
    } catch (err) {
      if (this.ended) return;
      if (err instanceof HttpException && err.getStatus() >= 400 && err.getStatus() < 500) {
        const response = err.getResponse();
        const code =
          typeof response === "object" && response && "code" in response ? String(response.code) : "NETWORKING_SESSION_EXPIRED";
        this.end({ event: "session-ended", data: { code } });
        return;
      }
      logger.warn({ err, eventId: this.ctx.event.id }, "Networking stream session check failed; client will resume");
      this.end({ event: "reconnect", data: { reason: "error" } });
    }
  }

  /** Idempotent: stop timers, leave the hub and the shutdown registry, send the last frame, close. */
  end(frame?: SseFrame): void {
    if (this.ended) return;
    this.ended = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
    this.unsubscribe();
    this.untrack();
    for (const callback of this.endCallbacks.splice(0)) {
      try {
        callback();
      } catch {
        // best effort
      }
    }
    if (frame && this.sse.isConnected) {
      void this.sse
        .send(frame)
        .catch(() => undefined)
        .finally(() => this.sse.close());
    } else {
      this.sse.close();
    }
  }
}

/**
 * GET /api/networking/:slug/stream: the participant PWA's notification feed.
 * Replaces the 3 s polling loop with hub signals, a keyset catch-up, Last-Event-ID
 * resume and a 60 s safety resync (see ParticipantStream).
 *
 * REALTIME_DISABLED: the stream stays available (it is the PWA's only live
 * feed). Notices written by api networking transactions still wake it in-process
 * after commit; notices from the worker or other transactions have no outbox
 * path then (no `networking.notify` rows, no pump), so they arrive at the next
 * 60 s resync.
 *
 * Process-local like the admin bus: one api instance (README "Realtime").
 */
@Injectable()
export class NetworkingStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<string, Set<ParticipantStream>>();

  constructor(
    private readonly service: NetworkingService,
    @Inject(CONFIG) private readonly config: Config,
    private readonly lifecycle: ShutdownCoordinator,
  ) {}

  // Api networking transactions publish their notices to the hub after commit.
  onModuleInit(): void {
    setNetworkingNoticePublisher((notices) => {
      for (const notice of notices) networkingNotificationHub.publish(notice);
    });
  }

  onModuleDestroy(): void {
    setNetworkingNoticePublisher(null);
  }

  /** Open streams of one session (tests, diagnostics). */
  openStreams(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0;
  }

  async open(slug: string, req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Draining for shutdown: 503 + Retry-After before authenticating.
    this.lifecycle.assertAcceptingStreams(reply);
    const authorization = req.headers.authorization;
    const ip = req.ip;
    // Auth and eligibility failures are ordinary HTTP errors (no stream yet).
    const ctx = await this.service.participant(slug, authorization, { ip });

    const header = req.headers["last-event-id"];
    const lastEventId = typeof header === "string" && header.length > 0 ? header : null;
    const resumeAt = lastEventId === null ? null : parseNetworkingStreamCursor(lastEventId, Date.now());
    reply.hijack();
    const stream = new ParticipantStream(
      new SseStream(reply),
      ctx,
      {
        hub: networkingNotificationHub,
        lifecycle: this.lifecycle,
        readPage: networkingNotificationsPage,
        checkSession: () => this.service.participant(slug, authorization, { ip }),
        heartbeatMs: this.config.realtime.heartbeatMs,
        clientRetryMs: this.config.realtime.clientRetryMs,
      },
      { at: resumeAt, gap: lastEventId !== null && resumeAt === null ? lastEventId.slice(0, 64) : null },
    );
    this.admit(stream);
    await stream.start();
  }

  /** At most `maxPerSession` open streams per session: the oldest makes room (`event: replaced`). */
  private admit(stream: ParticipantStream): void {
    const key = stream.sessionId;
    let set = this.sessions.get(key);
    if (!set) {
      set = new Set();
      this.sessions.set(key, set);
    }
    set.add(stream);
    stream.onEnd(() => {
      const current = this.sessions.get(key);
      current?.delete(stream);
      if (current?.size === 0) this.sessions.delete(key);
    });
    while (set.size > NETWORKING_STREAM.maxPerSession) {
      const oldest = set.values().next().value;
      if (!oldest) break;
      oldest.end({ event: "replaced", data: { reason: "stream-limit" } });
      set.delete(oldest);
    }
  }
}
