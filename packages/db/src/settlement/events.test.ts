import { describe, expect, it } from "vitest";
import { settlementEventPair } from "./events";

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
