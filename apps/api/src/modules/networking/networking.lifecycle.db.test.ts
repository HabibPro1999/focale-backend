// Plan 4.7: meeting transitions, their reservation effects and notices, and
// the one-pending-request-per-requester-per-slot hold, on a migrated database.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getDb,
  expireNetworkingProposals,
  maintainNetworkingLifecycle,
  networkingPendingHoldKey,
  networkingStore,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { createNetworkingWriteFixture } from "../../../../../packages/db/tests/helpers/networking-write-fixture";
import { NetworkingService, type NetworkingContext } from "./networking.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingAdminService } from "./networking.admin.service";
import { networkingHash } from "./networking.security";

const service = new NetworkingService();
const social = new NetworkingSocialService(service);
const meetings = new NetworkingMeetingsService(service);
const admin = new NetworkingAdminService(service, meetings);
const store = () => networkingStore(getDb());
const [ten, eleven] = ["10:00", "11:00"].map((time) => `2031-06-10T${time}:00.000Z`);
let fixture: Awaited<ReturnType<typeof createNetworkingWriteFixture>>;
let people: NetworkingContext[];

async function pair(a: number, b: number) {
  await social.interest(people[a], people[b].profile.id, "LIKE");
  await social.interest(people[b], people[a].profile.id, "LIKE");
}
const request = (from: number, to: number, startsAt: string) =>
  meetings.create(people[from], { profileId: people[to].profile.id, startsAt });
const reservations = (meetingId: string) => store().all("reservations", { eventId: fixture.event.id, meetingId });
const noticesFor = (meetingId: string, type: string) =>
  store().all("notifications", { eventId: fixture.event.id, type })
    .then((rows) => rows.filter((row) => row.data.meetingId === meetingId));

describe.runIf(dbTestsEnabled())("networking meeting lifecycle", () => {
  beforeAll(() => {
    process.env.NETWORKING_TOKEN_SECRET ??= "test-networking-secret-at-least-32-characters";
  });
  beforeEach(async () => {
    fixture = await createNetworkingWriteFixture({
      size: 4, slots: [new Date(ten), new Date(eleven)], tables: 2, hash: networkingHash,
    });
    people = fixture.participants.map(({ profile, session }) => ({
      event: fixture.event, config: fixture.config, profile, session,
    }));
    await pair(0, 1);
    await pair(0, 2);
    await pair(3, 1);
  }, 240_000);

  it("a pending request holds its table and one pending slot for its requester, never the participants", async () => {
    const first = await request(0, 1, ten);
    const keys = new Set((await reservations(first.id)).map((row) => row.resourceKey));
    expect(first.status).toBe("PENDING");
    expect(keys).toEqual(new Set([`table:${first.tableId}`, networkingPendingHoldKey(people[0].profile.id)]));

    // A second pending request by the same requester for the same slot, even to someone else.
    await expect(request(0, 2, ten)).rejects.toMatchObject({
      status: 409, response: { code: "NETWORKING_SLOT_CONFLICT", message: expect.stringContaining("pending meeting request") },
    });
    // Rescheduling another pending request onto that slot is refused too, and changes nothing.
    const later = await request(0, 2, eleven);
    const heldLater = (await reservations(later.id)).map((row) => row.id).sort();
    await expect(meetings.respond(people[2], later.id, { action: "RESCHEDULE", startsAt: ten }))
      .rejects.toMatchObject({ status: 409, response: { code: "NETWORKING_SLOT_CONFLICT" } });
    expect((await reservations(later.id)).map((row) => row.id).sort()).toEqual(heldLater);

    // Another requester is unaffected, and declining frees the requester's slot.
    expect((await request(3, 1, ten)).status).toBe("PENDING");
    await meetings.respond(people[1], first.id, { action: "DECLINE" });
    expect(await reservations(first.id)).toHaveLength(0);
    expect((await request(0, 2, ten)).status).toBe("PENDING");
  });

  it("attendance keeps every reservation; an organizer cancellation releases them and says so", async () => {
    const attended = await meetings.respond(people[1], (await request(0, 1, ten)).id, { action: "ACCEPT" });
    expect(attended.status).toBe("CONFIRMED");
    const held = (await reservations(attended.id)).map((row) => row.id).sort();
    expect(held.length).toBeGreaterThan(0);
    // Attendance can be recorded once the meeting has started.
    await store().update("meetings", { eventId: fixture.event.id, id: attended.id }, { startsAt: new Date(Date.now() - 60_000) });
    expect((await admin.updateMeeting(fixture.event.id, attended.id, { action: "NO_SHOW" }, "organizer")).status).toBe("NO_SHOW");
    expect((await reservations(attended.id)).map((row) => row.id).sort()).toEqual(held);

    const cancelled = await meetings.respond(people[1], (await request(3, 1, eleven)).id, { action: "ACCEPT" });
    expect(await reservations(cancelled.id)).not.toHaveLength(0);
    expect((await admin.updateMeeting(fixture.event.id, cancelled.id, { action: "CANCEL" }, "organizer")).status).toBe("CANCELLED");
    expect(await reservations(cancelled.id)).toHaveLength(0);
    const notices = await noticesFor(cancelled.id, "MEETING_CANCEL");
    expect(notices.map((row) => row.profileId).sort()).toEqual([people[1].profile.id, people[3].profile.id].sort());
    for (const notice of notices) expect(notice.data).toMatchObject({ action: "CANCEL", reason: "ORGANIZER", status: "CANCELLED" });
  });

  it("expiry releases only the reservations of the requests it expires; maintenance sweeps leftovers", async () => {
    const overdue = await request(0, 1, ten);
    await store().update("meetings", { eventId: fixture.event.id, id: overdue.id }, { expiresAt: new Date(Date.now() - 1000) });
    // A released meeting whose reservations were left behind (written outside a transition).
    const stray = await request(3, 1, eleven);
    await store().update("meetings", { eventId: fixture.event.id, id: stray.id }, { status: "CANCELLED" });
    expect(await reservations(stray.id)).not.toHaveLength(0);

    await expireNetworkingProposals(fixture.event.id, getDb());
    expect((await store().one("meetings", { eventId: fixture.event.id, id: overdue.id }))?.status).toBe("EXPIRED");
    expect(await reservations(overdue.id)).toHaveLength(0);
    expect(await reservations(stray.id)).not.toHaveLength(0);

    await maintainNetworkingLifecycle(fixture.event.id);
    expect(await reservations(stray.id)).toHaveLength(0);
  });

  it("cancellation notices carry their reason; a block's notices name no one", async () => {
    const own = await meetings.respond(people[1], (await request(0, 1, ten)).id, { action: "ACCEPT" });
    await meetings.respond(people[0], own.id, { action: "CANCEL", message: "Running late" });
    const cancelled = await noticesFor(own.id, "MEETING_CANCEL");
    expect(cancelled).toHaveLength(2);
    for (const notice of cancelled)
      expect(notice.data).toMatchObject({ reason: "PARTICIPANT", counterpartName: expect.any(String) });

    const blocked = await meetings.respond(people[2], (await request(0, 2, eleven)).id, { action: "ACCEPT" });
    await social.block(people[2], people[0].profile.id);
    expect((await store().one("meetings", { eventId: fixture.event.id, id: blocked.id }))?.status).toBe("CANCELLED");
    expect(await reservations(blocked.id)).toHaveLength(0);
    const confidential = await noticesFor(blocked.id, "MEETING_CANCELLED");
    expect(confidential.map((row) => row.profileId).sort()).toEqual([people[0].profile.id, people[2].profile.id].sort());
    for (const notice of confidential) {
      expect(notice.title).toBe("Meeting cancelled");
      expect(notice.data).toMatchObject({ action: "CANCEL", reason: "UNAVAILABLE", status: "CANCELLED" });
      expect(notice.data).not.toHaveProperty("counterpartName");
      expect(notice.data).not.toHaveProperty("tableName");
    }
  });
});
