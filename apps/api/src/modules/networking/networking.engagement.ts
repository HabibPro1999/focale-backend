import { NETWORKING_PLANNED_MEETING_STATUSES } from "@app/contracts";
import type { NetworkingRow } from "@app/db";

/** Shared gesture fallback and per-participant activity definitions. */
export function networkingEngagement({ profiles, interests, connections, messages, meetings, audit }: {
  profiles: NetworkingRow<"profiles">[];
  interests: NetworkingRow<"interests">[];
  connections: NetworkingRow<"connections">[];
  messages: NetworkingRow<"messages">[];
  meetings: NetworkingRow<"meetings">[];
  audit: NetworkingRow<"audit">[];
}) {
  const planned = meetings.filter((meeting) =>
    NETWORKING_PLANNED_MEETING_STATUSES.includes(meeting.status),
  );
  const gestures = audit.filter(entry => entry.action === "SWIPE_LIKE" || entry.action === "SWIPE_PASS")
    .map(entry => ({ profileId: entry.actorId, targetId: entry.targetId, action: entry.action === "SWIPE_LIKE" ? "LIKE" : "PASS" }));
  const recordedPairs = new Set(gestures.map(entry => `${entry.profileId}:${entry.targetId}`));
  // Older/imported state has no gesture audit; keep it without double-counting audited targets.
  const actions = [...gestures, ...interests.filter(interest => !recordedPairs.has(`${interest.profileId}:${interest.targetId}`))];
  const likes = actions.filter(interest => interest.action === "LIKE").length;
  const swipedProfiles = new Map<string, Set<string>>();
  const engagement = new Map(
    profiles.map((profile) => [
      profile.id,
      {
        profileId: profile.id,
        name: `${profile.firstName} ${profile.lastName}`,
        swipes: 0,
        likes: 0,
        matches: 0,
        messages: 0,
        meetings: 0,
        completedMeetings: 0,
      },
    ]),
  );
  for (const interest of actions) {
    const targets = swipedProfiles.get(interest.profileId) ?? new Set<string>();
    targets.add(interest.targetId ?? `legacy:${targets.size}`);
    swipedProfiles.set(interest.profileId, targets);
    const row = engagement.get(interest.profileId);
    if (row) {
      row.swipes++;
      if (interest.action === "LIKE") row.likes++;
    }
  }
  for (const connection of connections)
    for (const id of [connection.profileAId, connection.profileBId]) {
      const row = engagement.get(id);
      if (row) row.matches++;
    }
  const senders = new Map<string, Set<string>>();
  for (const message of messages) {
    const row = engagement.get(message.senderId);
    if (row) row.messages++;
    const participants = senders.get(message.connectionId) ?? new Set();
    participants.add(message.senderId);
    senders.set(message.connectionId, participants);
  }
  for (const meeting of planned)
    for (const id of [meeting.requesterId, meeting.recipientId]) {
      const row = engagement.get(id);
      if (row) {
        row.meetings++;
        if (meeting.status === "COMPLETED") row.completedMeetings++;
      }
    }
  return { planned, actions, likes, swipedProfiles, engagement, senders };
}
