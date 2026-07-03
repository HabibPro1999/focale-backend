import { EventEmitter } from "node:events";
import type { AppEvent } from "@app/contracts";
import { logger } from "../../core/logger.service";

const CHANNEL = "event";
const BUFFER_SIZE = 500;

export type AppEventHandler = (ev: AppEvent, id: string) => void;

export interface BufferedEvent {
  id: string;
  ev: AppEvent;
}

/**
 * Process-local pub/sub over a single Node EventEmitter channel, with a
 * 500-event ring buffer for SSE reconnect replay. Singleton per process; the
 * buffer and id counter reset on restart (a deploy gap is unrecoverable — a
 * client's next reconnect gets a replay-gap advisory). Ported verbatim from the
 * legacy `src/core/events/bus.ts`.
 */
class EventBus {
  private emitter = new EventEmitter();
  private wrapped = new Map<AppEventHandler, AppEventHandler>();
  private buffer: BufferedEvent[] = [];
  private nextId = 1;

  constructor() {
    // Every SSE connection registers a listener; unlimited avoids the
    // MaxListenersExceededWarning.
    this.emitter.setMaxListeners(0);
  }

  emit(ev: AppEvent): string {
    const id = String(this.nextId++);
    this.buffer.push({ id, ev });
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
    logger.info(
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
   * Buffered events with numeric id STRICTLY greater than `lastEventId`. Empty
   * for a falsy/non-numeric id or when nothing newer is retained.
   */
  getSince(lastEventId: string | null | undefined): BufferedEvent[] {
    if (!lastEventId) return [];
    const after = Number(lastEventId);
    if (!Number.isFinite(after)) return [];
    const idx = this.buffer.findIndex((b) => Number(b.id) > after);
    return idx === -1 ? [] : this.buffer.slice(idx);
  }

  /** True when the client resumes from before the retained window (events lost). */
  hasReplayGap(lastEventId: string | null | undefined): boolean {
    if (!lastEventId || this.buffer.length === 0) return false;
    const after = Number(lastEventId);
    if (!Number.isFinite(after)) return false;
    const firstBuffered = Number(this.buffer[0].id);
    return after < firstBuffered - 1;
  }

  listenerCount(): number {
    return this.emitter.listenerCount(CHANNEL);
  }
}

export const eventBus = new EventBus();
