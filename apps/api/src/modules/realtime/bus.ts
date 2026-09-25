import { EventEmitter } from "node:events";
import type { AppEvent } from "@app/contracts";
import { logger } from "../../core/logger.service";

const CHANNEL = "event";
/** Replay ring size per tenant (clientId). */
export const REPLAY_RING_SIZE = 500;

export type AppEventHandler = (ev: AppEvent, id: string) => void;

export interface BufferedEvent {
  id: string;
  ev: AppEvent;
}

interface ReplayRing {
  events: BufferedEvent[];
  /** Id of the newest event this ring evicted (0 when none). */
  lastEvictedId: number;
}

/**
 * Process-local pub/sub over a single Node EventEmitter channel, with one
 * replay ring per tenant (clientId, 500 events each) for SSE reconnect replay,
 * so one tenant's burst cannot evict another tenant's history. Ids come from
 * one process-wide counter (the SSE `id:`), so they stay monotonic across
 * tenants. Singleton per process; the rings and the counter reset on restart
 * (a deploy gap is unrecoverable: a client's next reconnect gets a replay-gap
 * advisory). This is why the API must run as a single instance: another
 * instance would neither see these events nor know these ids.
 */
class EventBus {
  private emitter = new EventEmitter();
  private wrapped = new Map<AppEventHandler, AppEventHandler>();
  private rings = new Map<string, ReplayRing>();
  private nextId = 1;

  constructor() {
    // Every SSE connection registers a listener; unlimited avoids the
    // MaxListenersExceededWarning.
    this.emitter.setMaxListeners(0);
  }

  emit(ev: AppEvent): string {
    const id = String(this.nextId++);
    let ring = this.rings.get(ev.clientId);
    if (!ring) {
      ring = { events: [], lastEvictedId: 0 };
      this.rings.set(ev.clientId, ring);
    }
    ring.events.push({ id, ev });
    if (ring.events.length > REPLAY_RING_SIZE) {
      ring.lastEvictedId = Number(ring.events.shift()!.id);
    }
    logger.debug(
      {
        type: ev.type,
        eventId: ev.eventId,
        id,
        listeners: this.emitter.listenerCount(CHANNEL),
      },
      "[realtime] emit",
    );
    this.emitter.emit(CHANNEL, ev, id);
    return id;
  }

  on(handler: AppEventHandler): void {
    const wrapped: AppEventHandler = (ev, id) => {
      try {
        handler(ev, id);
      } catch (err) {
        logger.error(
          { err, type: ev.type },
          "EventBus listener threw; isolated from other listeners",
        );
      }
    };
    this.wrapped.set(handler, wrapped);
    this.emitter.on(CHANNEL, wrapped);
  }

  off(handler: AppEventHandler): void {
    const wrapped = this.wrapped.get(handler);
    if (!wrapped) return;
    this.emitter.off(CHANNEL, wrapped);
    this.wrapped.delete(handler);
  }

  /**
   * The tenant's buffered events with numeric id STRICTLY greater than
   * `lastEventId`. Empty for a falsy/non-numeric id or when nothing newer is
   * retained.
   */
  getSince(lastEventId: string | null | undefined, clientId: string): BufferedEvent[] {
    const after = parseId(lastEventId);
    const ring = this.rings.get(clientId);
    if (after === null || !ring) return [];
    const idx = ring.events.findIndex((b) => Number(b.id) > after);
    return idx === -1 ? [] : ring.events.slice(idx);
  }

  /**
   * True when events of this tenant were lost between the client's last id
   * and what this process can replay: the tenant's ring evicted an event newer
   * than that id, or the id was issued by a previous process (the counter
   * resets to 1 on restart, so an id at or beyond `nextId` cannot be ours).
   */
  hasReplayGap(lastEventId: string | null | undefined, clientId: string): boolean {
    const after = parseId(lastEventId);
    if (after === null) return false;
    if (after >= this.nextId) return true;
    return (this.rings.get(clientId)?.lastEvictedId ?? 0) > after;
  }

  listenerCount(): number {
    return this.emitter.listenerCount(CHANNEL);
  }
}

function parseId(lastEventId: string | null | undefined): number | null {
  if (!lastEventId) return null;
  const id = Number(lastEventId);
  return Number.isFinite(id) ? id : null;
}

export const eventBus = new EventBus();
