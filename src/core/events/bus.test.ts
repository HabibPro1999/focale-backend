import { describe, expect, it, vi } from "vitest";
import { eventBus } from "./bus.js";
import type { AppEvent } from "./types.js";

function makeEvent(overrides: Partial<AppEvent> = {}): AppEvent {
  return {
    type: "registration.updated",
    clientId: "client-1",
    eventId: "event-1",
    payload: { id: "reg-1" },
    ts: Date.now(),
    ...overrides,
  } as AppEvent;
}

describe("eventBus", () => {
  it("delivers events to all registered listeners in order", () => {
    const received: AppEvent[] = [];
    const handler = (ev: AppEvent) => received.push(ev);
    eventBus.on(handler);

    const a = makeEvent({ payload: { id: "a" } });
    const b = makeEvent({ payload: { id: "b" } });
    eventBus.emit(a);
    eventBus.emit(b);

    expect(received).toEqual([a, b]);
    eventBus.off(handler);
  });

  it("supports many concurrent listeners without leak warnings", () => {
    const before = eventBus.listenerCount();
    const handlers = Array.from({ length: 100 }, () => vi.fn());
    handlers.forEach((h) => eventBus.on(h));
    expect(eventBus.listenerCount()).toBe(before + 100);

    eventBus.emit(makeEvent());
    handlers.forEach((h) => expect(h).toHaveBeenCalledTimes(1));

    handlers.forEach((h) => eventBus.off(h));
    expect(eventBus.listenerCount()).toBe(before);
  });

  it("off removes only the exact handler", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    eventBus.on(h1);
    eventBus.on(h2);

    eventBus.off(h1);
    eventBus.emit(makeEvent());

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
    eventBus.off(h2);
  });

  it("isolates listener failures so other listeners still receive the event", () => {
    const throwing = () => {
      throw new Error("boom");
    };
    const other = vi.fn();
    eventBus.on(throwing);
    eventBus.on(other);

    expect(() => eventBus.emit(makeEvent())).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
    eventBus.off(throwing);
    eventBus.off(other);
  });
});
