import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEvent } from "@app/contracts";

const mocks = vi.hoisted(() => ({
  enqueueRealtimeOutboxEvent: vi.fn(),
  syncNetworkingRegistration: vi.fn(),
}));
vi.mock("../outbox", () => ({ enqueueRealtimeOutboxEvent: mocks.enqueueRealtimeOutboxEvent }));
vi.mock("../queries/networking", () => ({ syncNetworkingRegistration: mocks.syncNetworkingRegistration }));

import { emitSettlementEvents, settlementEventPair } from "./events";

const base = { id: "reg1", eventId: "ev1", clientId: "c1" };

describe("settlementEventPair", () => {
  it("announces a newly fully-settled registration as paymentConfirmed", () => {
    const [event] = settlementEventPair({ ...base, oldStatus: "PENDING", newStatus: "PAID", emitCountsChanged: false });
    expect(event).toMatchObject({ type: "registration.paymentConfirmed", payload: { id: "reg1", paymentStatus: "PAID" } });
  });

  it.each([
    ["PAID", "SPONSORED"],
    ["PENDING", "PARTIAL"],
    ["PAID", "PAID"],
  ])("sends registration.updated for %s → %s", (oldStatus, newStatus) => {
    const [event] = settlementEventPair({ ...base, oldStatus, newStatus, emitCountsChanged: false });
    expect(event?.type).toBe("registration.updated");
  });

  it("keeps the old status when none is given, and adds countsChanged on request", () => {
    const events = settlementEventPair({ ...base, oldStatus: "PARTIAL", newStatus: undefined, emitCountsChanged: true });
    expect(events.map((event) => event.type)).toEqual(["registration.updated", "eventAccess.countsChanged"]);
    expect(events[0]?.payload).toEqual({ id: "reg1", paymentStatus: "PARTIAL" });
    expect(events[1]?.payload).toEqual({ id: "ev1", accessIds: [] });
  });

  it("lists the access items that moved when given", () => {
    const events = settlementEventPair({
      ...base,
      oldStatus: "PENDING",
      newStatus: "PENDING",
      emitCountsChanged: true,
      accessIds: ["a", "b"],
    });
    expect(events[1]?.payload).toEqual({ id: "ev1", accessIds: ["a", "b"] });
  });
});

describe("emitSettlementEvents", () => {
  const events = settlementEventPair({ ...base, oldStatus: "PENDING", newStatus: "PAID", emitCountsChanged: true });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncNetworkingRegistration.mockResolvedValue(undefined);
  });

  it("re-projects the registration, then enqueues one event at a time, in order", async () => {
    const started: string[] = [];
    let release!: () => void;
    const firstDone = new Promise<void>((resolve) => (release = resolve));
    mocks.enqueueRealtimeOutboxEvent.mockImplementation(async (_tx: unknown, event: AppEvent) => {
      started.push(event.type);
      if (started.length === 1) await firstDone;
      return event.type;
    });

    const pending = emitSettlementEvents({} as never, events);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The second insert waits for the first.
    expect(started).toEqual(["registration.paymentConfirmed"]);
    release();

    expect(await pending).toEqual(["registration.paymentConfirmed", "eventAccess.countsChanged"]);
    expect(mocks.syncNetworkingRegistration).toHaveBeenCalledWith("reg1", {});
    expect(mocks.syncNetworkingRegistration.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enqueueRealtimeOutboxEvent.mock.invocationCallOrder[0]!,
    );
  });

  it("stops at the first failed insert", async () => {
    mocks.enqueueRealtimeOutboxEvent.mockRejectedValueOnce(new Error("insert failed"));
    await expect(emitSettlementEvents({} as never, events)).rejects.toThrow("insert failed");
    expect(mocks.enqueueRealtimeOutboxEvent).toHaveBeenCalledTimes(1);
  });
});
