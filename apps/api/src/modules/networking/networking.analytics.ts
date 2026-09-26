import { networkingInventoryResource } from "./networking.inventory-policy";
import {
  getDb,
  getNetworkingConfig,
  networkingDailyMetrics,
  networkingEmailMetrics,
  networkingEventTotals,
  networkingHourlyActivity,
  networkingPeakSlots,
  networkingSectorMetrics,
  networkingStore,
  networkingTableUsageSources,
  networkingTopEngagement,
  networkingZoneMetrics,
  type NetworkingTableUsageSources,
} from "@app/db";
import type { NetworkingConfig } from "@app/contracts";
import { networkingSlots, resourceQuanta } from "./networking.policy";

/** `engagement` lists the most engaged participants only; the participants export has everyone. */
export const NETWORKING_ENGAGEMENT_LIMIT = 50;

const rate = (part: number, whole: number) => (whole ? part / whole : 0);

/**
 * Meeting-station minutes per table over the configured opening slots, and
 * the minutes booked meetings occupy. A table is one station; a stand has one
 * per active representative (`networkingInventoryResource`), and a stand
 * meeting occupies only its representative's station.
 */
export function networkingTableUsage(
  sources: NetworkingTableUsageSources,
  config: NetworkingConfig,
  event: { startDate: Date; endDate: Date },
) {
  const openQuanta = new Set(
    networkingSlots(config, event)
      .flatMap((slot) =>
        resourceQuanta(new Date(slot), new Date(Date.parse(slot) + config.slotDurationMinutes * 60_000)),
      )
      .map((stamp) => stamp.getTime()),
  );
  const bySpace = new Map(sources.spaces.map((space) => [space.id, space]));
  const byTable = new Map<string, NetworkingTableUsageSources["meetings"]>();
  for (const meeting of sources.meetings) {
    const assigned = byTable.get(meeting.tableId) ?? [];
    assigned.push(meeting);
    byTable.set(meeting.tableId, assigned);
  }
  return sources.tables.map((table) => {
    const representatives = sources.representatives.filter(
      (profile) => profile.standTableId === table.id || profile.id === table.ownerProfileId,
    );
    const stations = table.kind === "TABLE" ? 1 : representatives.length;
    const active = table.active && (!table.spaceId || bySpace.get(table.spaceId)?.active === true);
    const assigned = byTable.get(table.id) ?? [];
    const occupied = new Set(assigned.flatMap((meeting) => {
      const resource = meeting.requester && meeting.recipient
        ? networkingInventoryResource(table, [meeting.requester, meeting.recipient])
        : null;
      if (!resource || (table.kind === "STAND" && !representatives.some((profile) => resource.endsWith(`:profile:${profile.id}`))))
        return [];
      return resourceQuanta(meeting.startsAt, meeting.endsAt)
        .filter((stamp) => openQuanta.has(stamp.getTime())).map((stamp) => `${resource}:${stamp.getTime()}`);
    }));
    const availableMinutes = active ? openQuanta.size * 5 * stations : 0;
    const occupiedMinutes = active ? occupied.size * 5 : 0;
    return {
      tableId: table.id, name: table.name, location: table.location, active, meetings: assigned.length,
      availableMinutes, occupiedMinutes, occupancyRate: rate(occupiedMinutes, availableMinutes),
    };
  });
}

/**
 * Organizer analytics (plan 4.9): SQL aggregates over the event
 * (`networking-metrics.ts`, the post-event report's definitions). Rates are
 * fractions. Participants are the listed profiles; `engagement` holds the
 * `NETWORKING_ENGAGEMENT_LIMIT` most engaged of `engagementTotal`.
 */
export async function networkingAnalytics(eventId: string, now = new Date()) {
  const event = await networkingStore(getDb()).one("events", { id: eventId });
  if (!event) throw new Error("Networking event not found");
  const config = await getNetworkingConfig(eventId);
  const { timezone } = config;
  const totals = await networkingEventTotals(eventId, { timezone, now });
  const tableUsage = networkingTableUsage(await networkingTableUsageSources(eventId), config, event);
  const availableMinutes = tableUsage.reduce((sum, row) => sum + row.availableMinutes, 0);
  const occupiedMinutes = tableUsage.reduce((sum, row) => sum + row.occupiedMinutes, 0);
  const peakSlots = await networkingPeakSlots(eventId, timezone);
  const zones = await networkingZoneMetrics(eventId);
  const hourlyActivity = await networkingHourlyActivity(eventId, timezone);
  const timeSeries = (await networkingDailyMetrics(eventId, timezone)).map((day) => ({
    date: day.date, matches: day.connections, messages: day.messages, meetings: day.meetings, bookingRequests: day.bookingRequests,
  }));
  const sectors = (await networkingSectorMetrics(eventId, { unspecified: "Unspecified" })).map((row) => ({
    sector: row.sector, participants: row.participants, matches: row.connections, meetings: row.meetings,
  }));
  const engagement = await networkingTopEngagement(eventId, NETWORKING_ENGAGEMENT_LIMIT);
  const email = await networkingEmailMetrics(eventId);
  const { participants, likes, connections } = totals;
  return {
    profiles: participants,
    activeProfiles: totals.activeParticipants,
    visibleProfiles: totals.visibleParticipants,
    profileViews: totals.profileViews,
    activationRate: rate(totals.activatedParticipants, participants),
    conversations: totals.conversations,
    responseRate: rate(totals.responsiveConversations, totals.conversations),
    meetingConversionRate: rate(totals.convertedConnections, connections),
    likes,
    passes: totals.passes,
    matches: connections,
    matchRate: rate(connections, likes),
    interestReciprocityRate: likes ? Math.min(1, (2 * connections) / likes) : 0,
    matchedParticipantsRate: rate(totals.matchedParticipants, participants),
    messagedParticipantsRate: rate(totals.messagedParticipants, participants),
    messages: totals.messages,
    meetings: totals.meetingRequests,
    plannedMeetings: totals.bookedMeetings,
    todayMeetings: totals.todayMeetings,
    confirmedMeetings: totals.confirmedMeetings,
    completedMeetings: totals.completedMeetings,
    cancelledMeetings: totals.cancelledMeetings,
    noShowMeetings: totals.noShowMeetings,
    pendingMeetings: totals.awaitingMeetings,
    tableOccupancyRate: rate(occupiedMinutes, availableMinutes),
    tableUsage,
    peakSlots,
    zones,
    engagementTenSwipes: totals.tenSwipeParticipants,
    engagementTenSwipesRate: rate(totals.tenSwipeParticipants, participants),
    punctuality: {
      checkins: totals.checkins,
      onTime: totals.onTimeCheckins,
      onTimeRate: rate(totals.onTimeCheckins, totals.checkins),
      averageDelayMinutes: rate(totals.lateMinutes, totals.checkins),
    },
    reports: totals.openReports,
    hourlyActivity,
    timeSeries,
    sectors,
    engagement,
    engagementTotal: participants,
    ...email,
  };
}
