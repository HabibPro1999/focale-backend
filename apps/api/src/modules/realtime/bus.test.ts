import { describe, expect, it, vi } from "vitest";
import { eventBus } from "./bus";
import type { AppEvent } from "@app/contracts";

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

  it("emit returns a monotonically increasing id and delivers it to handlers", () => {
    const received: Array<{ ev: AppEvent; id: string }> = [];
    const handler = (ev: AppEvent, id: string) => received.push({ ev, id });
    eventBus.on(handler);

    const id1 = eventBus.emit(makeEvent({ payload: { id: "x" } }));
    const id2 = eventBus.emit(makeEvent({ payload: { id: "y" } }));

    expect(Number(id2)).toBeGreaterThan(Number(id1));
    expect(received.map((r) => r.id)).toEqual([id1, id2]);
    eventBus.off(handler);
  });

  it("getSince replays events emitted strictly after the given id", () => {
    const a = eventBus.emit(makeEvent({ payload: { id: "a" } }));
    eventBus.emit(makeEvent({ payload: { id: "b" } }));
    eventBus.emit(makeEvent({ payload: { id: "c" } }));

    const since = eventBus.getSince(a);
    expect(since.map((x) => x.ev.payload.id)).toEqual(["b", "c"]);
  });

  it("getSince returns empty for null, empty, or non-numeric ids", () => {
    eventBus.emit(makeEvent());
    expect(eventBus.getSince(null)).toEqual([]);
    expect(eventBus.getSince(undefined)).toEqual([]);
    expect(eventBus.getSince("")).toEqual([]);
    expect(eventBus.getSince("not-a-number")).toEqual([]);
  });

  it("getSince returns empty when id is larger than any buffered event", () => {
    eventBus.emit(makeEvent());
    expect(eventBus.getSince("999999999")).toEqual([]);
  });

  it("marks a replay gap when the requested id predates the retained buffer", () => {
    const firstId = Number(
      eventBus.emit(makeEvent({ payload: { id: "first" } })),
    );
    for (let i = 0; i < 501; i++) {
      eventBus.emit(makeEvent({ payload: { id: `overflow-${i}` } }));
    }

    expect(eventBus.hasReplayGap(String(firstId))).toBe(true);
    expect(eventBus.hasReplayGap("not-a-number")).toBe(false);
  });

  it("marks a replay gap when the requested id exceeds anything this process issued (restart)", () => {
    const latest = eventBus.emit(makeEvent());
    expect(eventBus.hasReplayGap(latest)).toBe(false);
    // A restart resets the id counter, so a stored id from the previous
    // process is beyond everything this process has emitted.
    expect(eventBus.hasReplayGap("999999999")).toBe(true);
  });
});
