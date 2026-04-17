import { EventEmitter } from "node:events";
import { logger } from "@shared/utils/logger.js";
import type { AppEvent } from "./types.js";

const CHANNEL = "event";

export type AppEventHandler = (ev: AppEvent) => void;

class EventBus {
  private emitter = new EventEmitter();
  private wrapped = new Map<AppEventHandler, AppEventHandler>();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(ev: AppEvent): void {
    logger.info(
      {
        type: ev.type,
        eventId: ev.eventId,
        listeners: this.emitter.listenerCount(CHANNEL),
      },
      "[realtime] emit",
    );
    this.emitter.emit(CHANNEL, ev);
  }

  on(handler: AppEventHandler): void {
    const wrapped: AppEventHandler = (ev) => {
      try {
        handler(ev);
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

  listenerCount(): number {
    return this.emitter.listenerCount(CHANNEL);
  }
}

export const eventBus = new EventBus();
