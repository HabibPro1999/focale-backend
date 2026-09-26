import { networkingInventoryResource } from "./networking.inventory-policy";
import {
  networkingMeetingIs,
  getNetworkingConfig,
  networkingEmailMetrics,
  networkingProfileActive,
  networkingProfileListed,
  networkingStore,
  type NetworkingRow,
} from "@app/db";
import type { NetworkingAnalytics, NetworkingConfig } from "@app/contracts";
import { networkingSlots, resourceQuanta } from "./networking.policy";

type AnalyticsInput = {
  profiles: NetworkingRow<"profiles">[];
  interests: NetworkingRow<"interests">[];
  connections: NetworkingRow<"connections">[];
  messages: NetworkingRow<"messages">[];
  meetings: NetworkingRow<"meetings">[];
  tables: NetworkingRow<"tables">[];
  spaces?: NetworkingRow<"spaces">[];
  reports: NetworkingRow<"reports">[];
  audit: NetworkingRow<"audit">[];
  event: NetworkingRow<"events">;
  config: NetworkingConfig;
};

/**
 * Definitions are shared by the overview, exports and report charts. Rates are
 * fractions. Participants are the listed profiles (erased tombstones are left
 * out); "active" is `networkingProfileActive` (4.6 policy).
 */
export function calculateNetworkingAnalytics(
  input: AnalyticsInput,
  now = new Date(),
) {
  const profiles = input.profiles.filter(networkingProfileListed);
  const {
    interests,
    connections,
    messages,
    meetings,
    tables,
    reports,
    audit,
    event,
    config,
  } = input;
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const planned = meetings.filter((meeting) => networkingMeetingIs(meeting.status, "booked"));
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
  const dayRows = new Map<
    string,
    { date: string; matches: number; messages: number; meetings: number; bookingRequests: number }
  >();
  const dayRow = (stamp: Date) => {
    const key = date.format(stamp);
    let row = dayRows.get(key);
    if (!row) {
      row = { date: key, matches: 0, messages: 0, meetings: 0, bookingRequests: 0 };
      dayRows.set(key, row);
    }
    return row;
  };
  for (const connection of connections) dayRow(connection.createdAt).matches++;
  for (const message of messages) dayRow(message.createdAt).messages++;
  for (const meeting of planned) dayRow(meeting.startsAt).meetings++;
  for (const meeting of meetings) dayRow(meeting.createdAt).bookingRequests++;
  const hourlyActivity = Array.from({ length: 24 }, (_, hour) => ({ hour: `${String(hour).padStart(2, "0")}:00`, activity: 0 }));
  const activityTimes = [
    ...audit.filter(entry => ["SWIPE_LIKE", "SWIPE_PASS", "PROFILE_VIEW"].includes(entry.action)),
    ...messages, ...connections, ...meetings,
  ];
  for (const entry of activityTimes) hourlyActivity[Number(time.format(entry.createdAt).split(":")[0])].activity++;

  const sectorById = new Map(
    profiles.map((profile) => [profile.id, profile.sector || "Unspecified"]),
  );
  const sectorRows = new Map<
    string,
    { sector: string; participants: number; matches: number; meetings: number }
  >();
  for (const sector of sectorById.values()) {
    const row = sectorRows.get(sector) ?? {
      sector,
      participants: 0,
      matches: 0,
      meetings: 0,
    };
    row.participants++;
    sectorRows.set(sector, row);
  }
  for (const connection of connections)
    for (const sector of new Set([
      sectorById.get(connection.profileAId),
      sectorById.get(connection.profileBId),
    ])) {
      if (sector) sectorRows.get(sector)!.matches++;
    }
  for (const meeting of planned)
    for (const sector of new Set([
      sectorById.get(meeting.requesterId),
      sectorById.get(meeting.recipientId),
    ])) {
      if (sector) sectorRows.get(sector)!.meetings++;
    }
  const inventory = networkingSlots(config, event);
  const openQuanta = new Set(
    inventory
      .flatMap((slot) =>
        resourceQuanta(
          new Date(slot),
          new Date(Date.parse(slot) + config.slotDurationMinutes * 60_000),
        ),
      )
      .map((stamp) => stamp.getTime()),
  );
  const byProfile = new Map(profiles.map(profile => [profile.id, profile]));
  const bySpace = new Map((input.spaces ?? []).map(space => [space.id, space]));
  const tableUsage = tables.map((table) => {
    const representatives = profiles.filter(profile => (profile.standTableId === table.id || profile.id === table.ownerProfileId)
      && networkingProfileActive(profile) && profile.meetingsEnabled);
    const stations = table.kind === "TABLE" ? 1 : representatives.length;
    const active = table.active && (!table.spaceId || bySpace.get(table.spaceId)?.active === true);
    const assigned = planned.filter(meeting => meeting.tableId === table.id);
    const occupied = new Set(assigned.flatMap(meeting => {
      const requester = byProfile.get(meeting.requesterId), recipient = byProfile.get(meeting.recipientId);
      const resource = requester && recipient ? networkingInventoryResource(table, [requester, recipient]) : null;
      if (!resource || (table.kind === "STAND" && !representatives.some(profile => resource.endsWith(`:profile:${profile.id}`)))) return [];
      return resourceQuanta(meeting.startsAt, meeting.endsAt)
        .filter(stamp => openQuanta.has(stamp.getTime())).map(stamp => `${resource}:${stamp.getTime()}`);
    }));
    const availableMinutes = active ? openQuanta.size * 5 * stations : 0;
    const occupiedMinutes = active ? occupied.size * 5 : 0;
    return { tableId: table.id, name: table.name, location: table.location, active, meetings: assigned.length,
      availableMinutes, occupiedMinutes, occupancyRate: availableMinutes ? occupiedMinutes / availableMinutes : 0 };
  });
  const availableMinutes = tableUsage.reduce(
    (sum, row) => sum + row.availableMinutes,
    0,
  );
  const occupiedMinutes = tableUsage.reduce(
    (sum, row) => sum + row.occupiedMinutes,
    0,
  );
  const peaks = new Map<
    string,
    { date: string; time: string; meetings: number }
  >();
  const zones = new Map<string, number>();
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const arrivalDelays: number[] = [];
  for (const meeting of planned) {
    const day = date.format(meeting.startsAt),
      hour = time.format(meeting.startsAt),
      key = `${day}T${hour}`;
    const row = peaks.get(key) ?? { date: day, time: hour, meetings: 0 };
    row.meetings++;
    peaks.set(key, row);
    const zone =
      (meeting.tableId && tableById.get(meeting.tableId)?.spaceId
        ? bySpace.get(tableById.get(meeting.tableId)!.spaceId!)?.name : null) ||
      (meeting.tableId ? tableById.get(meeting.tableId)?.location : null) ||
      "Unspecified";
    zones.set(zone, (zones.get(zone) ?? 0) + 1);
    for (const arrival of [
      meeting.requesterCheckedInAt,
      meeting.recipientCheckedInAt,
    ])
      if (arrival)
        arrivalDelays.push(
          (arrival.getTime() - meeting.startsAt.getTime()) / 60_000,
        );
  }
  const reciprocal = [...senders.values()].filter(
    (participants) => participants.size === 2,
  ).length;
  const engagedTen = [...engagement.values()].filter(
    (row) => (swipedProfiles.get(row.profileId)?.size ?? 0) >= 10,
  ).length;
  const pair = (a: string, b: string) => [a, b].sort().join(":");
  const connectedPairs = new Set(
    connections.map((connection) =>
      pair(connection.profileAId, connection.profileBId),
    ),
  );
  const convertedPairs = new Set(
    planned
      .map((meeting) => pair(meeting.requesterId, meeting.recipientId))
      .filter((key) => connectedPairs.has(key)),
  );
  return {
    profiles: profiles.length,
    activeProfiles: profiles.filter(networkingProfileActive).length,
    visibleProfiles: profiles.filter(
      (profile) => profile.visible && networkingProfileActive(profile),
    ).length,
    profileViews: audit.filter((entry) => entry.action === "PROFILE_VIEW")
      .length,
    activationRate: profiles.length
      ? profiles.filter((profile) => profile.lastActiveAt !== null).length /
        profiles.length
      : 0,
    conversations: senders.size,
    responseRate: senders.size ? reciprocal / senders.size : 0,
    meetingConversionRate: connections.length
      ? convertedPairs.size / connections.length
      : 0,
    likes,
    passes: actions.length - likes,
    matches: connections.length,
    matchRate: likes ? connections.length / likes : 0,
    interestReciprocityRate: likes ? Math.min(1, (2 * connections.length) / likes) : 0,
    matchedParticipantsRate: profiles.length ? [...engagement.values()].filter(row => row.matches > 0).length / profiles.length : 0,
    messagedParticipantsRate: profiles.length ? [...engagement.values()].filter(row => row.messages > 0).length / profiles.length : 0,
    messages: messages.length,
    meetings: meetings.length,
    plannedMeetings: planned.length,
    todayMeetings: planned.filter(
      (meeting) => date.format(meeting.startsAt) === date.format(now),
    ).length,
    confirmedMeetings: meetings.filter(
      (meeting) => meeting.status === "CONFIRMED",
    ).length,
    completedMeetings: meetings.filter(
      (meeting) => meeting.status === "COMPLETED",
    ).length,
    cancelledMeetings: meetings.filter(
      (meeting) => meeting.status === "CANCELLED",
    ).length,
    noShowMeetings: meetings.filter((meeting) => meeting.status === "NO_SHOW")
      .length,
    pendingMeetings: meetings.filter((meeting) => networkingMeetingIs(meeting.status, "awaiting")).length,
    tableOccupancyRate: availableMinutes
      ? occupiedMinutes / availableMinutes
      : 0,
    tableUsage,
    peakSlots: [...peaks.values()].sort(
      (a, b) =>
        b.meetings - a.meetings ||
        `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`),
    ),
    zones: [...zones].map(([zone, meetings]) => ({ zone, meetings })),
    engagementTenSwipes: engagedTen,
    engagementTenSwipesRate: profiles.length ? engagedTen / profiles.length : 0,
    punctuality: {
      checkins: arrivalDelays.length,
      onTime: arrivalDelays.filter((delay) => delay <= 5).length,
      onTimeRate: arrivalDelays.length
        ? arrivalDelays.filter((delay) => delay <= 5).length /
          arrivalDelays.length
        : 0,
      averageDelayMinutes: arrivalDelays.length
        ? arrivalDelays.reduce((sum, delay) => sum + Math.max(0, delay), 0) /
          arrivalDelays.length
        : 0,
    },
    reports: reports.filter((report) => report.status === "OPEN").length,
    hourlyActivity,
    timeSeries: [...dayRows.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
    sectors: [...sectorRows.values()],
    engagement: [...engagement.values()],
  };
}
export async function networkingAnalytics(
  eventId: string,
): Promise<
  NetworkingAnalytics & ReturnType<typeof calculateNetworkingAnalytics>
> {
  const store = networkingStore();
  const [
    profiles,
    interests,
    connections,
    messages,
    meetings,
    tables,
    spaces,
    reports,
    audit,
    event,
    config,
    email,
  ] = await Promise.all([
    store.all("profiles", { eventId }),
    store.all("interests", { eventId }),
    store.all("connections", { eventId }),
    store.all("messages", { eventId }),
    store.all("meetings", { eventId }),
    store.all("tables", { eventId }),
    store.all("spaces", { eventId }),
    store.all("reports", { eventId }),
    store.all("audit", { eventId }),
    store.one("events", { id: eventId }),
    getNetworkingConfig(eventId),
    networkingEmailMetrics(eventId),
  ]);
  if (!event) throw new Error("Networking event not found");
  return {
    ...calculateNetworkingAnalytics({
      profiles,
      interests,
      connections,
      messages,
      meetings,
      tables,
      spaces,
      reports,
      audit,
      event,
      config,
    }),
    ...email,
  };
}
