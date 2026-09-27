import { describe, expect, it } from "vitest";
import { NetworkingExportsService } from "./networking.exports.service";
import type { NetworkingSocialService } from "./networking.social.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
import type { NetworkingContext } from "./networking.service";

describe("participant calendar bytes", () => {
  it.each(["CONFIRMED", "CANCELLED"])("preserves %s calendar content, escaping and UTF-8 folding", async (status) => {
    const row = {
      id: "meeting", requesterId: "self", status, revision: 7,
      updatedAt: new Date("2031-04-05T08:00:00.123Z"),
      startsAt: new Date("2031-04-05T09:00:00.000Z"), endsAt: new Date("2031-04-05T09:30:00.000Z"),
      recipient: { firstName: "é".repeat(40) + "😀,;", lastName: "Peer" },
      table: { name: "A\\B", location: "Room;1,2\r\nNorth" }, message: "Line1\r\nLine2,;\\end",
    };
    const service = new NetworkingExportsService({} as NetworkingSocialService, {
      allMeetings: async () => [row, { ...row, id: "no-show", status: "NO_SHOW" }],
    } as unknown as NetworkingMeetingsService);
    const calendar = await service.calendar({ profile: { id: "self" } } as NetworkingContext);
    expect(calendar).not.toContain("no-show");
    expect(calendar.endsWith("\r\n")).toBe(true);
    for (const line of calendar.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(74);
    expect(calendar).toMatchSnapshot();
  });
});
