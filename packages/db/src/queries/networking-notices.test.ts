import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(async () => true) }));
vi.mock("../outbox/outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../outbox/outbox")>()),
  enqueueOutboxEvent: mocks.enqueue,
}));

import { configureOutbox } from "../outbox/outbox";
import { NETWORKING_NOTIFY_TYPE, REALTIME_OUTBOX_TYPES } from "../outbox/types";
import type { DbExecutor } from "../client";
import {
  bufferNetworkingNotices,
  isNetworkingNotifyPayload,
  publishNetworkingNotices,
  setNetworkingNoticePublisher,
  signalNetworkingNotification,
} from "./networking-notices";

const notice = { eventId: "event-1", profileId: "profile-1", notificationId: "notification-1" };
const executor = () => ({}) as DbExecutor;

afterEach(() => {
  setNetworkingNoticePublisher(null);
  configureOutbox({ realtimeDisabled: false });
  mocks.enqueue.mockClear();
});

describe("networking notices (4.3)", () => {
  it("is a realtime-scoped outbox type (api pump, 24 h retention, never requeued)", () => {
    expect(NETWORKING_NOTIFY_TYPE).toBe("networking.notify");
    expect(REALTIME_OUTBOX_TYPES).toEqual(["realtime.emit", "networking.notify"]);
  });

  it("without an in-process publisher, writes a networking.notify outbox row with IDs only, on the caller's executor", async () => {
    const db = executor();
    await signalNetworkingNotification(db, { ...notice, title: "secret" } as typeof notice);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(db, {
      type: "networking.notify",
      payload: { eventId: "event-1", profileId: "profile-1", notificationId: "notification-1" },
      aggregateType: "networking.notification",
      aggregateId: "notification-1",
      eventId: "event-1",
      maxAttempts: 10,
    });
  });

  it("with a publisher, buffers on a networking transaction's executor instead; other executors still use the outbox", async () => {
    setNetworkingNoticePublisher(vi.fn());
    const tx = executor();
    const buffer = bufferNetworkingNotices(tx);
    await signalNetworkingNotification(tx, notice);
    expect(buffer).toEqual([{ eventId: "event-1", profileId: "profile-1" }]);
    expect(mocks.enqueue).not.toHaveBeenCalled();

    await signalNetworkingNotification(executor(), notice);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it("a buffer is ignored when no publisher is registered (the worker): the outbox row is written", async () => {
    const tx = executor();
    const buffer = bufferNetworkingNotices(tx);
    await signalNetworkingNotification(tx, notice);
    expect(buffer).toEqual([]);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it("writes no outbox row under REALTIME_DISABLED (nothing would drain it)", async () => {
    configureOutbox({ realtimeDisabled: true });
    await signalNetworkingNotification(executor(), notice);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("publishes one notice per participant and never throws after commit", () => {
    const publisher = vi.fn(() => {
      throw new Error("hub down");
    });
    setNetworkingNoticePublisher(publisher);
    const a = { eventId: "e", profileId: "a" };
    expect(() => publishNetworkingNotices([a, { eventId: "e", profileId: "b" }, { ...a }])).not.toThrow();
    expect(publisher).toHaveBeenCalledExactlyOnceWith([a, { eventId: "e", profileId: "b" }]);
    publisher.mockClear();
    publishNetworkingNotices([]);
    expect(publisher).not.toHaveBeenCalled();
  });

  it("validates a pump payload: three non-empty id strings", () => {
    expect(isNetworkingNotifyPayload(notice)).toBe(true);
    for (const bad of [null, "x", {}, { ...notice, profileId: "" }, { ...notice, eventId: 1 }])
      expect(isNetworkingNotifyPayload(bad)).toBe(false);
  });
});
