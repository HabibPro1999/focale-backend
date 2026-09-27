import { expect, it } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import { networkingMeetingAttachment, type NetworkingNotificationContext } from "@app/integrations";
import { NetworkingExportsService } from "./networking.exports.service";
import type { NetworkingSocialService } from "./networking.social.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
import type { NetworkingContext } from "./networking.service";

it.each(["comma, semi; slash\\ carriage\r\nnext", "مرحبا🙂é".repeat(20)])("pins each calendar's escaped and byte-folded output for %s", async (text) => {
  const meeting = {
    id: "meeting", requesterId: "viewer", recipientId: "target", status: "CONFIRMED", revision: 2,
    updatedAt: new Date("2030-01-01T09:00:00.123Z"), startsAt: new Date("2030-01-02T09:00:00.456Z"), endsAt: new Date("2030-01-02T10:00:00.789Z"),
    message: text, recipient: { firstName: text, lastName: "Person" }, table: { name: text, location: "Room" },
  };
  const exports = new NetworkingExportsService({} as NetworkingSocialService, { allMeetings: async () => [meeting] } as unknown as NetworkingMeetingsService);
  const api = await exports.calendar({ profile: { id: "viewer" } } as NetworkingContext);
  const attachments = networkingMeetingAttachment({
    meeting, event: { name: text }, profile: { language: "en" }, table: meeting.table,
    config: NetworkingConfigSchema.parse({ defaultLanguage: "en" }), contact: null, blocked: false,
  } as unknown as NetworkingNotificationContext);
  const email = Buffer.from(attachments[0]!.content, "base64").toString("utf8");
  expect({ api, email }).toMatchSnapshot();
  for (const document of [api, email]) {
    expect(document.endsWith("\r\n")).toBe(true);
    expect(document).toContain("DTSTAMP:20300101T090000Z\r\n");
    expect(document.split("\r\n").every((line) => Buffer.byteLength(line) <= 74)).toBe(true);
  }
});
