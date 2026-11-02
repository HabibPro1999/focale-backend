import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import { getDb, networkingStore, listNetworkingAdminAudit } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../../../../../packages/db/tests/helpers/cleanup";
import { seedClient, seedEvent, seedForm, seedRegistration, seedUser } from "../../../../../packages/db/tests/helpers/factories";
import { NetworkingAdminService } from "./networking.admin.service";
import { NetworkingService } from "./networking.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingInventoryService } from "./networking.inventory.service";
const networking = new NetworkingService();
const service = new NetworkingAdminService(networking, new NetworkingMeetingsService(networking), new NetworkingInventoryService());
async function fixture() {
  const store = networkingStore(getDb());
  const client = await seedClient({ enabledModules: ["networking"] });
  const event = await seedEvent({ clientId: client.id, startDate: new Date("2035-01-01T00:00:00Z"), endDate: new Date("2035-01-02T23:00:00Z") });
  const config = NetworkingConfigSchema.parse({ enabled: true, meetingsEnabled: true, slotDurationMinutes: 30,
    timezone: "UTC", openingHours: [{ date: "2035-01-01", start: "09:00", end: "17:00" }] });
  await store.insert("configs", { eventId: event.id, config });
  const form = await seedForm({ eventId: event.id });
  const profiles = [];
  for (const name of ["One", "Two"]) {
    const reg = await seedRegistration({ eventId: event.id, formId: form.id, paymentStatus: "PAID", networkingOptIn: true });
    profiles.push(await store.insert("profiles", { eventId: event.id, registrationId: reg.id, email: reg.email,
      firstName: name, lastName: "Test", company: "Company", jobTitle: "Director", sector: "Tech",
      status: "ACTIVE", consent: true, visible: true, availabilitySet: true, meetingsEnabled: true }));
  }
  const [a,b] = profiles;
  const [profileAId,profileBId] = [a.id,b.id].sort();
  await store.insert("connections", { eventId: event.id, profileAId, profileBId });
  const startsAt = new Date("2035-01-01T10:00:00Z");
  for (const p of profiles) await store.insert("availability", { eventId: event.id, profileId: p.id, startsAt });
  const table = await store.insert("tables", { eventId: event.id, name: "T1", active: true });
  const meeting = await store.insert("meetings", { eventId: event.id, requesterId: a.id, recipientId: b.id, startsAt,
    endsAt: new Date("2035-01-01T10:30:00Z"), expiresAt: new Date("2035-01-01T09:50:00Z"), status: "CONFIRMED", tableId: table.id });
  return { store, event, a,b, meeting };
}
describe.runIf(dbTestsEnabled())("networking undo", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("restores a cancelled meeting through allocation and refuses a blocked counterpart", async () => {
    const f = await fixture();
    await service.updateMeeting(f.event.id, f.meeting.id, { action: "CANCEL" }, "admin");
    await service.updateMeeting(f.event.id, f.meeting.id, { action: "RESTORE", notify: false }, "admin");
    expect(await f.store.one("meetings", { id: f.meeting.id })).toMatchObject({ status: "CONFIRMED", revision: 3 });
    expect((await f.store.all("reservations", { meetingId: f.meeting.id })).length).toBeGreaterThan(0);
    await service.updateMeeting(f.event.id, f.meeting.id, { action: "CANCEL" }, "admin");
    await f.store.insert("blocks", { eventId: f.event.id, profileId: f.b.id, targetId: f.a.id });
    await expect(service.updateMeeting(f.event.id, f.meeting.id, { action: "RESTORE" }, "admin")).rejects.toMatchObject({ status: 409 });
    expect(await f.store.one("meetings", { id: f.meeting.id })).toMatchObject({ status: "CANCELLED" });
    expect(await f.store.all("reservations", { meetingId: f.meeting.id })).toEqual([]);
  });
  it("reopens a report and clears resolution metadata without changing access", async () => {
    const f = await fixture();
    const report = await f.store.insert("reports", { eventId: f.event.id, reporterId: f.a.id, profileId: f.b.id, reason: "Test report" });
    await service.moderate(f.event.id, report.id, { action: "RESOLVE", note: "Reviewed" }, "admin");
    expect(await service.moderate(f.event.id, report.id, { action: "REOPEN" }, "admin")).toMatchObject({ status: "OPEN", resolvedBy: null, resolvedAt: null });
    expect(await f.store.one("profiles", { id: f.b.id })).toMatchObject({ status: "ACTIVE" });
  });

  it("undoes suspension with its meetings, keeps old sessions revoked, and is idempotent", async () => {
    const f = await fixture();
    await f.store.insert("sessions", { eventId: f.event.id, profileId: f.a.id, tokenHash: "test-hash",
      expiresAt: new Date("2035-01-01T10:00:00Z") });
    const changed = await service.updateProfile(f.event.id, f.a.id, { status: "SUSPENDED", notify: false }, "admin");
    expect(changed.accessUndoId).toBeTruthy();
    expect(await f.store.one("meetings", { id: f.meeting.id })).toMatchObject({ status: "CANCELLED" });
    const result = await service.restoreAccess(f.event.id, f.a.id, { undoId: changed.accessUndoId!, notify: false }, "admin");
    expect(result.profile.status).toBe("ACTIVE");
    expect(await f.store.one("meetings", { id: f.meeting.id })).toMatchObject({ status: "CONFIRMED" });
    expect((await f.store.one("sessions", { profileId: f.a.id }))?.revokedAt).toBeInstanceOf(Date);
    await expect(service.restoreAccess(f.event.id, f.a.id, { undoId: changed.accessUndoId!, notify: false }, "admin")).resolves.toMatchObject({ alreadyRestored: true });
  });
  it("rolls back the whole access Undo when restoring a meeting conflicts", async () => {
    const f = await fixture();
    const changed = await service.updateProfile(f.event.id, f.a.id, { status: "SUSPENDED", notify: false }, "admin");
    await f.store.insert("blocks", { eventId: f.event.id, profileId: f.b.id, targetId: f.a.id });
    await expect(service.restoreAccess(f.event.id, f.a.id, { undoId: changed.accessUndoId!, notify: false }, "admin")).rejects.toMatchObject({ status: 409 });
    expect(await f.store.one("profiles", { id: f.a.id })).toMatchObject({ status: "SUSPENDED" });
    expect(await f.store.one("meetings", { id: f.meeting.id })).toMatchObject({ status: "CANCELLED" });
  });

  it("loads individual admin records and rejects IDs from another event", async () => {
    const f = await fixture(); const other = await seedEvent();
    const report = await f.store.insert("reports", { eventId: f.event.id, reporterId: f.a.id, profileId: f.b.id, reason: "Test report" });
    expect(await service.getProfile(f.event.id, f.a.id)).toMatchObject({ id: f.a.id, matchCount: 1 });
    expect(await service.getMeeting(f.event.id, f.meeting.id)).toMatchObject({ id: f.meeting.id, requester: { id: f.a.id } });
    expect(await service.getReport(f.event.id, report.id)).toMatchObject({ id: report.id, reporter: { id: f.a.id } });
    for (const read of [() => service.getProfile(other.id, f.a.id), () => service.getMeeting(other.id, f.meeting.id), () => service.getReport(other.id, report.id)]) {
      await expect(read()).rejects.toMatchObject({ status: 404 });
    }
  });

  it("includes organizer names alongside moderation IDs", async () => {
    const f = await fixture(); const actor = await seedUser({ name: "Organizer Name" });
    const report = await f.store.insert("reports", { eventId: f.event.id, reporterId: f.a.id, profileId: f.b.id, reason: "Test report" });
    await service.moderate(f.event.id, report.id, { action: "RESOLVE" }, actor.id);
    expect(await service.getReport(f.event.id, report.id)).toMatchObject({ resolvedBy: actor.id, resolvedByName: "Organizer Name" });
    const audit = await listNetworkingAdminAudit(f.event.id, { page: 1, limit: 10 });
    expect(audit.items.find(a => a.action === "REPORT_RESOLVE")).toMatchObject({ actorId: actor.id, actorName: "Organizer Name" });
  });

});
