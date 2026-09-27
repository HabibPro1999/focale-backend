import { cancelNetworkingParticipantMeetings, revokeNetworkingSessions, type DbExecutor } from "@app/db";

/** Both operations share the caller's transaction and keep their existing order. */
export async function revokeParticipantAccess(profileId: string, eventId: string, db: DbExecutor) {
  await revokeNetworkingSessions(profileId, db);
  await cancelNetworkingParticipantMeetings(profileId, eventId, db);
}
