import { EventEmitter } from "node:events";
import { logger } from "@shared/utils/logger.js";
import type { AppEvent } from "./types.js";

const CHANNEL = "event";
const BUFFER_SIZE = 500;

export type AppEventHandler = (ev: AppEvent, id: string) => void;

export interface BufferedEvent {
  id: string;
  ev: AppEvent;
}

class EventBus {
  private emitter = new EventEmitter();
  private wrapped = new Map<AppEventHandler, AppEventHandler>();
  private buffer: BufferedEvent[] = [];
  private nextId = 1;

  constructor() {
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
   * Returns buffered events emitted strictly after `lastEventId`. Used to
   * replay the gap between an SSE disconnect and the next successful connect.
   * Unparseable or unknown ids return an empty list (no replay). The buffer
   * is process-local and resets on restart; a deploy gap is unrecoverable.
   */
  getSince(lastEventId: string | null | undefined): BufferedEvent[] {
    if (!lastEventId) return [];
    const after = Number(lastEventId);
    if (!Number.isFinite(after)) return [];
    const idx = this.buffer.findIndex((b) => Number(b.id) > after);
    return idx === -1 ? [] : this.buffer.slice(idx);
  }

  listenerCount(): number {
    return this.emitter.listenerCount(CHANNEL);
  }
}

export const eventBus = new EventBus();
