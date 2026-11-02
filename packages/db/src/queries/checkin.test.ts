import { describe, expect, it } from "vitest";
import { batchCheckIn, CHECK_IN_BATCH_TX_SIZE, type BatchCheckInItem } from "./checkin";

const item: BatchCheckInItem = {
  registrationId: "reg-1",
  eventId: "event-1",
  clientId: null,
  checkedInBy: "staff",
  checkedInAt: new Date("2030-01-01T09:00:00.000Z"),
};

describe("batchCheckIn bounds", () => {
  it("writes at most 100 items per transaction", async () => {
    expect(CHECK_IN_BATCH_TX_SIZE).toBe(100);
    await expect(
      batchCheckIn(Array.from({ length: CHECK_IN_BATCH_TX_SIZE + 1 }, () => item)),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("returns no results for no items without opening a transaction", async () => {
    await expect(batchCheckIn([])).resolves.toEqual([]);
  });
});
