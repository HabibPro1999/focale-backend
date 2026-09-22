import { expect, it, vi } from "vitest";
import type { DbExecutor } from "../client";
vi.mock("./networking-participant-read", () => ({ networkingUnreadMessageCount: async () => 0 }));
import { listNetworkingNotifications } from "./networking-read";
it("selects notification data with the full notification row", async () => {
  const items = [{ id: "n", data: { counterpartName: "Alice", meetingId: "m", startsAt: "2099-01-01T09:00:00Z" } }];
  const rows = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), offset: vi.fn().mockResolvedValue(items) };
  const counts = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([{ total: 1, unreadCount: 1 }]) };
  const db = { select: vi.fn().mockReturnValueOnce(rows).mockReturnValueOnce(counts) };
  const result = await listNetworkingNotifications("event", "profile", 1, 30, db as unknown as DbExecutor);
  expect(db.select.mock.calls[0]).toEqual([]);
  expect(result.items).toEqual(items);
});
