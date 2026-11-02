import { cancelNetworkingParticipantMeetings, revokeNetworkingSessions, type DbExecutor } from "@app/db";

/** Sessions then meetings, on the caller's transaction; cache eviction stays after commit. */
export async function revokeParticipantAccess(profileId: string, eventId: string, db: DbExecutor, options: { notify?: boolean } = {}) {
  await revokeNetworkingSessions(profileId, db);
  return cancelNetworkingParticipantMeetings(profileId, eventId, db, options);
}
