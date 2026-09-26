import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";
import { networkingProfiles } from "../schema/networking";
import { activeProfile, listedProfile } from "../policy/networking-eligibility";
import { networkingMeetingStatusSql } from "./networking-meetings";

/**
 * Networking event metrics (plan 4.9): the one set of definitions behind the
 * organizer analytics and the post-event report. Every figure is an SQL
 * aggregate over the event's rows; only bounded result rows leave the database
 * (sectors, days, hours, peak slots, zones, the top engagement rows and the
 * table-usage inputs).
 *
 * Definitions:
 * - participants: listed profiles (4.6 `listedProfile`: erased tombstones are
 *   left out); active and visible ones follow `activeProfile`
 *   (`networkingProfileActive`); activated ones have been seen in the PWA.
 * - likes and passes: the interests as they stand (a participant who changes
 *   a like into a pass, or resets their passes, counts once, as it is now).
 *   A participant's swipes are their interests, one per target.
 * - matches: connections; a conversation is a connection with messages, a
 *   responsive one has messages from both sides; a connection converts when
 *   its pair has a booked meeting.
 * - meetings: every request; booked (`CONFIRMED`, `COMPLETED`, `NO_SHOW`) and
 *   awaiting (`PENDING`, `PENDING_ALLOCATION`) follow the meeting groups.
 * - days, hours and slots are the event timezone's wall clock. Meeting
 *   `created_at` is a naive UTC timestamp (the shared `timestamps` columns);
 *   the other stamps are timestamptz.
 */

const p = alias(networkingProfiles, "p");
const listed = listedProfile(p);
const active = activeProfile(p);
const booked = networkingMeetingStatusSql("booked");
const awaiting = networkingMeetingStatusSql("awaiting");

export type NetworkingEventTotals = {
  participants: number;
  activeParticipants: number;
  visibleParticipants: number;
  activatedParticipants: number;
  matchedParticipants: number;
  messagedParticipants: number;
  /** Participants who swiped at least ten other participants. */
  tenSwipeParticipants: number;
  profileViews: number;
  likes: number;
  passes: number;
  connections: number;
  convertedConnections: number;
  messages: number;
  conversations: number;
  responsiveConversations: number;
  meetingRequests: number;
  bookedMeetings: number;
  awaitingMeetings: number;
  confirmedMeetings: number;
  completedMeetings: number;
  noShowMeetings: number;
  cancelledMeetings: number;
  /** Booked meetings starting on `now`'s day in the event timezone. */
  todayMeetings: number;
  openReports: number;
  /** Participant arrivals at booked meetings, the on-time ones (≤ 5 min late) and the summed lateness in minutes (early counts as 0). */
  checkins: number;
  onTimeCheckins: number;
  lateMinutes: number;
};

/** Every event-wide count, in one statement. */
export async function networkingEventTotals(
  eventId: string,
  options: { timezone: string; now?: Date },
  db: DbExecutor = getDb(),
): Promise<NetworkingEventTotals> {
  const { timezone } = options;
  const now = (options.now ?? new Date()).toISOString();
  const [row] = rowsOf<Record<string, number>>(
    await db.execute(sql`
    SELECT prof.*, ints.*, conn.*, msg.*, meet.*, arrivals.*,
      (SELECT count(*)::int4 FROM networking_audit WHERE event_id=${eventId} AND action='PROFILE_VIEW') AS profile_views,
      (SELECT count(*)::int4 FROM networking_reports WHERE event_id=${eventId} AND status='OPEN') AS open_reports,
      (SELECT count(*)::int4 FROM networking_connections c WHERE c.event_id=${eventId}
        AND EXISTS (SELECT 1 FROM networking_meetings m WHERE m.event_id=c.event_id AND m.status IN (${booked})
          AND ((m.requester_id=c.profile_a_id AND m.recipient_id=c.profile_b_id)
            OR (m.requester_id=c.profile_b_id AND m.recipient_id=c.profile_a_id)))) AS converted_connections
    FROM
      (SELECT count(*)::int4 AS participants,
        count(*) FILTER (WHERE ${active})::int4 AS active_participants,
        count(*) FILTER (WHERE ${active} AND p.visible)::int4 AS visible_participants,
        count(*) FILTER (WHERE p.last_active_at IS NOT NULL)::int4 AS activated_participants,
        count(*) FILTER (WHERE matched.profile_id IS NOT NULL)::int4 AS matched_participants,
        count(*) FILTER (WHERE messaged.sender_id IS NOT NULL)::int4 AS messaged_participants,
        count(*) FILTER (WHERE swiped.swipes>=10)::int4 AS ten_swipe_participants
      FROM networking_profiles p
      LEFT JOIN (SELECT profile_a_id AS profile_id FROM networking_connections WHERE event_id=${eventId}
        UNION SELECT profile_b_id FROM networking_connections WHERE event_id=${eventId}) matched ON matched.profile_id=p.id
      LEFT JOIN (SELECT DISTINCT sender_id FROM networking_messages WHERE event_id=${eventId}) messaged ON messaged.sender_id=p.id
      LEFT JOIN (SELECT profile_id, count(*) AS swipes FROM networking_interests WHERE event_id=${eventId}
        GROUP BY profile_id) swiped ON swiped.profile_id=p.id
      WHERE p.event_id=${eventId} AND ${listed}) prof,
      (SELECT count(*) FILTER (WHERE action='LIKE')::int4 AS likes, count(*) FILTER (WHERE action='PASS')::int4 AS passes
      FROM networking_interests WHERE event_id=${eventId}) ints,
      (SELECT count(*)::int4 AS connections FROM networking_connections WHERE event_id=${eventId}) conn,
      (SELECT coalesce(sum(sent),0)::int4 AS messages, count(*)::int4 AS conversations,
        count(*) FILTER (WHERE senders=2)::int4 AS responsive_conversations
      FROM (SELECT connection_id, count(*) AS sent, count(DISTINCT sender_id) AS senders FROM networking_messages
        WHERE event_id=${eventId} GROUP BY connection_id) per_connection) msg,
      (SELECT count(*)::int4 AS meeting_requests,
        count(*) FILTER (WHERE status IN (${booked}))::int4 AS booked_meetings,
        count(*) FILTER (WHERE status IN (${awaiting}))::int4 AS awaiting_meetings,
        count(*) FILTER (WHERE status='CONFIRMED')::int4 AS confirmed_meetings,
        count(*) FILTER (WHERE status='COMPLETED')::int4 AS completed_meetings,
        count(*) FILTER (WHERE status='NO_SHOW')::int4 AS no_show_meetings,
        count(*) FILTER (WHERE status='CANCELLED')::int4 AS cancelled_meetings,
        count(*) FILTER (WHERE status IN (${booked}) AND to_char(starts_at AT TIME ZONE ${timezone},'YYYY-MM-DD')
          =to_char(${now}::timestamptz AT TIME ZONE ${timezone},'YYYY-MM-DD'))::int4 AS today_meetings
      FROM networking_meetings WHERE event_id=${eventId}) meet,
      (SELECT count(*)::int4 AS checkins, count(*) FILTER (WHERE late<=5)::int4 AS on_time_checkins,
        coalesce(sum(greatest(late,0::float8)),0)::float8 AS late_minutes
      FROM (SELECT ((extract(epoch FROM requester_checked_in_at)-extract(epoch FROM starts_at))/60)::float8 AS late
          FROM networking_meetings WHERE event_id=${eventId} AND status IN (${booked}) AND requester_checked_in_at IS NOT NULL
        UNION ALL SELECT ((extract(epoch FROM recipient_checked_in_at)-extract(epoch FROM starts_at))/60)::float8
          FROM networking_meetings WHERE event_id=${eventId} AND status IN (${booked}) AND recipient_checked_in_at IS NOT NULL) arrival) arrivals
  `),
  );
  const value = (key: string) => Number(row?.[key] ?? 0);
  return {
    participants: value("participants"),
    activeParticipants: value("active_participants"),
    visibleParticipants: value("visible_participants"),
    activatedParticipants: value("activated_participants"),
    matchedParticipants: value("matched_participants"),
    messagedParticipants: value("messaged_participants"),
    tenSwipeParticipants: value("ten_swipe_participants"),
    profileViews: value("profile_views"),
    likes: value("likes"),
    passes: value("passes"),
    connections: value("connections"),
    convertedConnections: value("converted_connections"),
    messages: value("messages"),
    conversations: value("conversations"),
    responsiveConversations: value("responsive_conversations"),
    meetingRequests: value("meeting_requests"),
    bookedMeetings: value("booked_meetings"),
    awaitingMeetings: value("awaiting_meetings"),
    confirmedMeetings: value("confirmed_meetings"),
    completedMeetings: value("completed_meetings"),
    noShowMeetings: value("no_show_meetings"),
    cancelledMeetings: value("cancelled_meetings"),
    todayMeetings: value("today_meetings"),
    openReports: value("open_reports"),
    checkins: value("checkins"),
    onTimeCheckins: value("on_time_checkins"),
    lateMinutes: value("late_minutes"),
  };
}

export type NetworkingSectorMetrics = { sector: string; participants: number; connections: number; meetings: number };

/**
 * Participants per sector, with the connections and booked meetings that
 * involve one of them (counted once per sector). A blank sector is reported
 * as `unspecified`. Largest sectors first.
 */
export async function networkingSectorMetrics(
  eventId: string,
  options: { unspecified: string },
  db: DbExecutor = getDb(),
): Promise<NetworkingSectorMetrics[]> {
  return rowsOf<NetworkingSectorMetrics>(
    await db.execute(sql`
    WITH lp AS (SELECT p.id, coalesce(nullif(p.sector,''),${options.unspecified}::text) AS sector
        FROM networking_profiles p WHERE p.event_id=${eventId} AND ${listed}),
      sector_connections AS (
        SELECT c.id, lp.sector FROM networking_connections c JOIN lp ON lp.id=c.profile_a_id WHERE c.event_id=${eventId}
        UNION SELECT c.id, lp.sector FROM networking_connections c JOIN lp ON lp.id=c.profile_b_id WHERE c.event_id=${eventId}),
      sector_meetings AS (
        SELECT m.id, lp.sector FROM networking_meetings m JOIN lp ON lp.id=m.requester_id
          WHERE m.event_id=${eventId} AND m.status IN (${booked})
        UNION SELECT m.id, lp.sector FROM networking_meetings m JOIN lp ON lp.id=m.recipient_id
          WHERE m.event_id=${eventId} AND m.status IN (${booked}))
    SELECT s.sector, s.participants, coalesce(sc.total,0)::int4 AS connections, coalesce(sm.total,0)::int4 AS meetings
    FROM (SELECT sector, count(*)::int4 AS participants FROM lp GROUP BY sector) s
    LEFT JOIN (SELECT sector, count(*) AS total FROM sector_connections GROUP BY sector) sc ON sc.sector=s.sector
    LEFT JOIN (SELECT sector, count(*) AS total FROM sector_meetings GROUP BY sector) sm ON sm.sector=s.sector
    ORDER BY s.participants DESC, s.sector
  `),
  );
}

export type NetworkingDailyMetrics = { date: string; connections: number; messages: number; meetings: number; bookingRequests: number };

/**
 * Activity per day in the event timezone: connections and messages by
 * creation, booked meetings by start, meeting requests by creation.
 */
export async function networkingDailyMetrics(
  eventId: string,
  timezone: string,
  db: DbExecutor = getDb(),
): Promise<NetworkingDailyMetrics[]> {
  return rowsOf<NetworkingDailyMetrics>(
    await db.execute(sql`
    SELECT to_char(stamp AT TIME ZONE ${timezone},'YYYY-MM-DD') AS "date",
      sum(connections)::int4 AS connections, sum(messages)::int4 AS messages,
      sum(meetings)::int4 AS meetings, sum(requests)::int4 AS "bookingRequests"
    FROM (
      SELECT created_at AS stamp,1 AS connections,0 AS messages,0 AS meetings,0 AS requests
        FROM networking_connections WHERE event_id=${eventId}
      UNION ALL SELECT created_at,0,1,0,0 FROM networking_messages WHERE event_id=${eventId}
      UNION ALL SELECT starts_at,0,0,1,0 FROM networking_meetings WHERE event_id=${eventId} AND status IN (${booked})
      UNION ALL SELECT created_at AT TIME ZONE 'UTC',0,0,0,1 FROM networking_meetings WHERE event_id=${eventId}
    ) activity GROUP BY 1 ORDER BY 1
  `),
  );
}

/**
 * Activity per hour of the day in the event timezone (all 24 hours): swipes,
 * profile views, messages, connections and meeting requests.
 */
export async function networkingHourlyActivity(
  eventId: string,
  timezone: string,
  db: DbExecutor = getDb(),
): Promise<Array<{ hour: string; activity: number }>> {
  const rows = rowsOf<{ hour: number; activity: number }>(
    await db.execute(sql`
    SELECT extract(hour FROM stamp AT TIME ZONE ${timezone})::int4 AS "hour", count(*)::int4 AS activity
    FROM (
      SELECT created_at AS stamp FROM networking_audit
        WHERE event_id=${eventId} AND action IN ('SWIPE_LIKE','SWIPE_PASS','PROFILE_VIEW')
      UNION ALL SELECT created_at FROM networking_messages WHERE event_id=${eventId}
      UNION ALL SELECT created_at FROM networking_connections WHERE event_id=${eventId}
      UNION ALL SELECT created_at AT TIME ZONE 'UTC' FROM networking_meetings WHERE event_id=${eventId}
    ) activity GROUP BY 1
  `),
  );
  const byHour = new Map(rows.map((row) => [Number(row.hour), Number(row.activity)]));
  return Array.from({ length: 24 }, (_, hour) => ({
    hour: `${String(hour).padStart(2, "0")}:00`,
    activity: byHour.get(hour) ?? 0,
  }));
}

/** Booked meetings per start slot (event timezone), busiest first. */
export async function networkingPeakSlots(
  eventId: string,
  timezone: string,
  db: DbExecutor = getDb(),
): Promise<Array<{ date: string; time: string; meetings: number }>> {
  return rowsOf<{ date: string; time: string; meetings: number }>(
    await db.execute(sql`
    SELECT "date", "time", meetings FROM (
      SELECT to_char(starts_at AT TIME ZONE ${timezone},'YYYY-MM-DD') AS "date",
        to_char(starts_at AT TIME ZONE ${timezone},'HH24:MI') AS "time", count(*)::int4 AS meetings
      FROM networking_meetings WHERE event_id=${eventId} AND status IN (${booked}) GROUP BY 1,2
    ) slots ORDER BY meetings DESC, "date", "time"
  `),
  );
}

/** Booked meetings per zone: the table's space, else its location, else "Unspecified". Busiest first. */
export async function networkingZoneMetrics(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<Array<{ zone: string; meetings: number }>> {
  return rowsOf<{ zone: string; meetings: number }>(
    await db.execute(sql`
    SELECT "zone", meetings FROM (
      SELECT coalesce(nullif(s.name,''),nullif(t.location,''),'Unspecified') AS "zone", count(*)::int4 AS meetings
      FROM networking_meetings m
      LEFT JOIN networking_tables t ON t.id=m.table_id AND t.event_id=m.event_id
      LEFT JOIN networking_spaces s ON s.id=t.space_id AND s.event_id=m.event_id
      WHERE m.event_id=${eventId} AND m.status IN (${booked}) GROUP BY 1
    ) zones ORDER BY meetings DESC, "zone"
  `),
  );
}

export type NetworkingParticipantEngagement = {
  profileId: string;
  name: string;
  swipes: number;
  likes: number;
  matches: number;
  messages: number;
  meetings: number;
  completedMeetings: number;
};

/**
 * The most engaged listed participants: most booked meetings, then matches,
 * messages and swipes (profile id breaks ties). Swipes are the participant's
 * interests; meetings are booked ones.
 */
export async function networkingTopEngagement(
  eventId: string,
  limit: number,
  db: DbExecutor = getDb(),
): Promise<NetworkingParticipantEngagement[]> {
  const rows = rowsOf<Omit<NetworkingParticipantEngagement, "name"> & { firstName: string; lastName: string }>(
    await db.execute(sql`
    SELECT p.id AS "profileId", p.first_name AS "firstName", p.last_name AS "lastName",
      coalesce(i.swipes,0)::int4 AS swipes, coalesce(i.likes,0)::int4 AS likes,
      coalesce(c.matches,0)::int4 AS matches, coalesce(sent.messages,0)::int4 AS messages,
      coalesce(mt.meetings,0)::int4 AS meetings, coalesce(mt.completed,0)::int4 AS "completedMeetings"
    FROM networking_profiles p
    LEFT JOIN (SELECT profile_id, count(*) AS swipes, count(*) FILTER (WHERE action='LIKE') AS likes
      FROM networking_interests WHERE event_id=${eventId} GROUP BY profile_id) i ON i.profile_id=p.id
    LEFT JOIN (SELECT profile_id, count(*) AS matches FROM (
        SELECT profile_a_id AS profile_id FROM networking_connections WHERE event_id=${eventId}
        UNION ALL SELECT profile_b_id FROM networking_connections WHERE event_id=${eventId}) ends
      GROUP BY profile_id) c ON c.profile_id=p.id
    LEFT JOIN (SELECT sender_id, count(*) AS messages FROM networking_messages WHERE event_id=${eventId}
      GROUP BY sender_id) sent ON sent.sender_id=p.id
    LEFT JOIN (SELECT profile_id, count(*) AS meetings, count(*) FILTER (WHERE status='COMPLETED') AS completed FROM (
        SELECT requester_id AS profile_id, status FROM networking_meetings WHERE event_id=${eventId} AND status IN (${booked})
        UNION ALL SELECT recipient_id, status FROM networking_meetings WHERE event_id=${eventId} AND status IN (${booked})) ends
      GROUP BY profile_id) mt ON mt.profile_id=p.id
    WHERE p.event_id=${eventId} AND ${listed}
    ORDER BY coalesce(mt.meetings,0) DESC, coalesce(c.matches,0) DESC, coalesce(sent.messages,0) DESC,
      coalesce(i.swipes,0) DESC, p.id
    LIMIT ${limit}
  `),
  );
  return rows.map(({ firstName, lastName, ...row }) => ({
    profileId: row.profileId,
    name: `${firstName} ${lastName}`,
    swipes: Number(row.swipes),
    likes: Number(row.likes),
    matches: Number(row.matches),
    messages: Number(row.messages),
    meetings: Number(row.meetings),
    completedMeetings: Number(row.completedMeetings),
  }));
}

export type NetworkingTableUsageSources = {
  tables: Array<{
    id: string;
    name: string;
    location: string;
    kind: "TABLE" | "STAND";
    active: boolean;
    spaceId: string | null;
    ownerProfileId: string | null;
  }>;
  spaces: Array<{ id: string; active: boolean }>;
  /** Active listed participants with meetings enabled who represent a stand (member or owner). */
  representatives: Array<{ id: string; standTableId: string | null }>;
  /** Booked meetings at a table; a participant is null when not listed. */
  meetings: Array<{
    id: string;
    tableId: string;
    startsAt: Date;
    endsAt: Date;
    requester: { id: string; standTableId: string | null } | null;
    recipient: { id: string; standTableId: string | null } | null;
  }>;
};

const rq = alias(networkingProfiles, "rq");
const rc = alias(networkingProfiles, "rc");

/** The inputs of table occupancy, which the inventory policy computes per meeting. */
export async function networkingTableUsageSources(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<NetworkingTableUsageSources> {
  const tables = rowsOf<NetworkingTableUsageSources["tables"][number]>(
    await db.execute(sql`
    SELECT id, name, location, kind, active, space_id AS "spaceId", owner_profile_id AS "ownerProfileId"
    FROM networking_tables WHERE event_id=${eventId} ORDER BY name, id
  `),
  );
  const spaces = rowsOf<NetworkingTableUsageSources["spaces"][number]>(
    await db.execute(sql`SELECT id, active FROM networking_spaces WHERE event_id=${eventId}`),
  );
  const representatives = rowsOf<NetworkingTableUsageSources["representatives"][number]>(
    await db.execute(sql`
    SELECT p.id, p.stand_table_id AS "standTableId" FROM networking_profiles p
    WHERE p.event_id=${eventId} AND ${listed} AND ${active} AND p.meetings_enabled
      AND (p.stand_table_id IS NOT NULL OR p.id IN (SELECT owner_profile_id FROM networking_tables
        WHERE event_id=${eventId} AND owner_profile_id IS NOT NULL))
  `),
  );
  const meetings = rowsOf<{
    id: string;
    tableId: string;
    startsAt: Date | string;
    endsAt: Date | string;
    requesterId: string | null;
    requesterStandTableId: string | null;
    recipientId: string | null;
    recipientStandTableId: string | null;
  }>(
    await db.execute(sql`
    SELECT m.id, m.table_id AS "tableId", m.starts_at AS "startsAt", m.ends_at AS "endsAt",
      rq.id AS "requesterId", rq.stand_table_id AS "requesterStandTableId",
      rc.id AS "recipientId", rc.stand_table_id AS "recipientStandTableId"
    FROM networking_meetings m
    LEFT JOIN networking_profiles rq ON rq.id=m.requester_id AND rq.event_id=m.event_id AND ${listedProfile(rq)}
    LEFT JOIN networking_profiles rc ON rc.id=m.recipient_id AND rc.event_id=m.event_id AND ${listedProfile(rc)}
    WHERE m.event_id=${eventId} AND m.table_id IS NOT NULL AND m.status IN (${booked})
  `),
  );
  return {
    tables,
    spaces,
    representatives,
    meetings: meetings.map((row) => ({
      id: row.id,
      tableId: row.tableId,
      startsAt: new Date(row.startsAt),
      endsAt: new Date(row.endsAt),
      requester: row.requesterId ? { id: row.requesterId, standTableId: row.requesterStandTableId } : null,
      recipient: row.recipientId ? { id: row.recipientId, standTableId: row.recipientStandTableId } : null,
    })),
  };
}
