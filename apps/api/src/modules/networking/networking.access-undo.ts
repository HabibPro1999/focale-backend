import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ErrorCodes, StoredNetworkingAccessUndoSchema, type NetworkingRestoreAccess } from "@app/contracts";
import { getDb, getNetworkingConfig, networkingStore, type NetworkingRow, type NetworkingStore } from "@app/db";
import type { NetworkingService } from "./networking.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
import { revokeParticipantAccess } from "./networking.revocation";
import { restoreNetworkingMeeting } from "./networking.meeting-restore";
import { networkingIdentityCache } from "../../core/networking-identity-cache";

function accessState(p: NetworkingRow<"profiles">) {
  return { status: p.status, consent: p.consent, visible: p.visible, meetingsEnabled: p.meetingsEnabled,
    ...(typeof p.overrides?.consent === "boolean" ? { consentOverride: p.overrides.consent } : {}) };
}
export async function recordNetworkingAccessUndo(store: NetworkingStore, actorId: string,
  before: NetworkingRow<"profiles">, after: NetworkingRow<"profiles">, cancelled: NetworkingRow<"meetings">[] = []) {
  if (JSON.stringify(accessState(before)) === JSON.stringify(accessState(after))) return undefined;
  const id = randomUUID();
  await store.insert("audit", { id, eventId: before.eventId, actorId, action: "PROFILE_ACCESS_SNAPSHOT", targetId: before.id,
    data: { before: accessState(before), after: accessState(after), afterUpdatedAt: after.updatedAt.toISOString(),
      meetings: cancelled.map(m => ({ id: m.id, revision: m.revision })) } });
  return id;
}
const stale = (message: string) => new ConflictException({ code: ErrorCodes.NETWORKING_ACTION_NOT_ALLOWED, message });
export async function restoreNetworkingAccess(eventId: string, profileId: string, input: NetworkingRestoreAccess,
  actorId: string, networking: NetworkingService, meetings: NetworkingMeetingsService) {
  const load = async (store: NetworkingStore) => {
    const audit = await store.one("audit", { eventId, id: input.undoId, targetId: profileId, action: "PROFILE_ACCESS_SNAPSHOT" });
    if (!audit) throw new NotFoundException({ code: ErrorCodes.NETWORKING_NOT_FOUND, message: "Access change not found" });
    return StoredNetworkingAccessUndoSchema.parse(audit.data);
  };
  const result = await meetings.allocation(eventId, async () => {
    const store = networkingStore(getDb()); const snapshot = await load(store);
    const intervals = [];
    for (const saved of snapshot.meetings) {
      const row = await store.one("meetings", { eventId, id: saved.id });
      if (row) intervals.push({ startsAt: row.startsAt, endsAt: row.endsAt });
    }
    return intervals;
  }, async (store, db) => {
    const snapshot = await load(store);
    const profile = await store.one("profiles", { eventId, id: profileId });
    if (!profile || profile.withdrawnAt || profile.erasedAt) throw stale("A withdrawn participant cannot be restored");
    const done = await store.one("audit", { eventId, targetId: input.undoId, action: "PROFILE_ACCESS_RESTORED" });
    if (done) return { profile, restoredMeetings: [], alreadyRestored: true };
    if (profile.updatedAt.toISOString() !== snapshot.afterUpdatedAt ||
        JSON.stringify(accessState(profile)) !== JSON.stringify(snapshot.after)) throw stale("Participant changed after this access decision");
    const { consentOverride, ...before } = snapshot.before;
    const overrides = { ...profile.overrides };
    if (consentOverride === undefined) delete overrides.consent;
    else overrides.consent = consentOverride;
    const [restored] = await store.update("profiles", { eventId, id: profileId }, { ...before, overrides,
      updatedAt: new Date(Math.max(Date.now(), profile.updatedAt.getTime() + 1)) });
    const event = await store.one("events", { id: eventId });
    if (!event) throw stale("Event no longer exists");
    const config = await getNetworkingConfig(eventId, db);
    if (restored.status === "ACTIVE" && restored.consent && !await networking.eligible(restored, config, store))
      throw stale("Participant is no longer eligible for networking");
    if (restored.status !== "ACTIVE" || !restored.consent) await revokeParticipantAccess(profileId, eventId, db, { notify: input.notify });
    const restoredMeetings: string[] = [];
    for (const saved of snapshot.meetings) {
      const row = await store.one("meetings", { eventId, id: saved.id });
      if (!row || row.revision !== saved.revision) throw stale("A cancelled meeting changed after this access decision");
      const meeting = await restoreNetworkingMeeting(event, config, row, store, meetings);
      restoredMeetings.push(meeting.id);
      if (input.notify !== false) await meetings.notify({ event }, meeting, "MEETING_ASSIGN", [meeting.requesterId, meeting.recipientId], db);
    }
    await store.insert("audit", { eventId, actorId, action: "PROFILE_ACCESS_RESTORED", targetId: input.undoId,
      data: { profileId, restoredMeetings } });
    return { profile: restored, restoredMeetings, alreadyRestored: false };
  });
  networkingIdentityCache.forgetProfile(profileId);
  return result;
}
