import { describe, expect, it, vi } from "vitest";
import { NetworkingNotificationHub } from "./networking-notification-hub";

describe("NetworkingNotificationHub (4.3)", () => {
  it("wakes only the streams of exactly that participant of exactly that event", () => {
    const hub = new NetworkingNotificationHub();
    const mine = vi.fn();
    const sameProfileIdOtherEvent = vi.fn();
    const sameEventOtherProfile = vi.fn();
    hub.subscribe({ eventId: "event-1", profileId: "profile-1" }, mine);
    hub.subscribe({ eventId: "event-2", profileId: "profile-1" }, sameProfileIdOtherEvent);
    hub.subscribe({ eventId: "event-1", profileId: "profile-2" }, sameEventOtherProfile);

    expect(hub.publish({ eventId: "event-1", profileId: "profile-2" })).toBe(1);
    expect(hub.publish({ eventId: "event-3", profileId: "profile-1" })).toBe(0);
    expect(mine).not.toHaveBeenCalled();
    expect(sameProfileIdOtherEvent).not.toHaveBeenCalled();
    expect(sameEventOtherProfile).toHaveBeenCalledOnce();

    expect(hub.publish({ eventId: "event-1", profileId: "profile-1" })).toBe(1);
    expect(mine).toHaveBeenCalledOnce();
    expect(sameProfileIdOtherEvent).not.toHaveBeenCalled();
    // A listener is only woken: it gets nothing it could leak.
    expect(mine.mock.calls[0]).toEqual([]);
  });

  it("cannot be confused by ids that concatenate to the same key", () => {
    const hub = new NetworkingNotificationHub();
    const listener = vi.fn();
    hub.subscribe({ eventId: "a:b", profileId: "c" }, listener);
    expect(hub.publish({ eventId: "a", profileId: "b:c" })).toBe(0);
    expect(hub.publish({ eventId: "a\nb", profileId: "c" })).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("wakes every stream of the participant, isolates a throwing listener, and forgets unsubscribed ones", () => {
    const hub = new NetworkingNotificationHub();
    const target = { eventId: "event-1", profileId: "profile-1" };
    const first = vi.fn(() => {
      throw new Error("boom");
    });
    const second = vi.fn();
    const offFirst = hub.subscribe(target, first);
    const offSecond = hub.subscribe(target, second);
    expect(hub.size).toBe(2);

    expect(hub.publish(target)).toBe(2);
    expect(second).toHaveBeenCalledOnce();

    offFirst();
    offFirst();
    expect(hub.publish(target)).toBe(1);
    offSecond();
    expect(hub.size).toBe(0);
    expect(hub.publish(target)).toBe(0);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });
});
