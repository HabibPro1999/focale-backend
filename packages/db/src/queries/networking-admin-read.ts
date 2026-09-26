import { and, asc, desc, eq, gte, inArray, lt, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";
import { withExportStatementTimeout } from "../txn";
import {
  networkingConnections as connections,
  networkingMeetings as meetings,
  networkingMessages as messages,
  networkingProfiles as profiles,
  networkingReports as reports,
  networkingTables,
} from "../schema/networking";
import { listedProfile } from "../policy/networking-eligibility";
import { networkingMeetingStatusSql } from "./networking-meetings";
import { networkingParticipantEngagement, type NetworkingEngagementCounts } from "./networking-metrics";
import { pagesByIds, type ExportPageOptions } from "./export-pages";

/**
 * Organizer lists and exports of an event's networking (plan 4.9). Lists are
 * one SQL page plus its count, with the page's relations loaded in bulk;
 * exports read ids in export order first, then rows 500 ids at a time, each
 * page in its own short transaction under the export statement timeout.
 * Erased profiles are tombstones (4.6 `listedProfile`): the participant list
 * and export leave them out, and other rows name them by id.
 */

type ProfileRow = typeof profiles.$inferSelect;
type Page = { page: number; limit: number };
const offsetOf = ({ page, limit }: Page) => (page - 1) * limit;
const total = sql<number>`count(*)::int4`.mapWith(Number);
const idList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}`), sql`,`);

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export type NetworkingAdminProfileQuery = Page & {
  /** Case-insensitive substring of "first last company role email". */
  q?: string;
  sector?: string;
  status?: string;
  /** `networkingActivity` tiers, or MATCHED / MEETINGS (at least one). */
  activity?: string;
};
export type NetworkingAdminProfile = ProfileRow & { matchCount: number; meetingCount: number };

const DAY_MS = 86_400_000;
/** A connection with the participant (either side). */
const hasConnection = (eventId: string) =>
  sql`(EXISTS (SELECT 1 FROM networking_connections lc WHERE lc.event_id=${eventId} AND lc.profile_a_id=${profiles.id})
    OR EXISTS (SELECT 1 FROM networking_connections lc WHERE lc.event_id=${eventId} AND lc.profile_b_id=${profiles.id}))`;
/** A meeting that still holds the participant (not cancelled, declined or expired). */
const hasHoldingMeeting = (eventId: string) =>
  sql`(EXISTS (SELECT 1 FROM networking_meetings lm WHERE lm.event_id=${eventId} AND lm.requester_id=${profiles.id}
      AND lm.status IN (${networkingMeetingStatusSql("holding")}))
    OR EXISTS (SELECT 1 FROM networking_meetings lm WHERE lm.event_id=${eventId} AND lm.recipient_id=${profiles.id}
      AND lm.status IN (${networkingMeetingStatusSql("holding")})))`;

/** SQL twin of `networkingActivity` (contracts) at `now`. */
function activityTier(tier: string, now: Date): SQL | undefined {
  const day = new Date(now.getTime() - DAY_MS);
  const week = new Date(now.getTime() - 7 * DAY_MS);
  if (tier === "VERY_ACTIVE") return gte(profiles.lastActiveAt, day);
  if (tier === "ACTIVE") return and(lt(profiles.lastActiveAt, day), gte(profiles.lastActiveAt, week));
  if (tier === "INACTIVE") return sql`(${profiles.lastActiveAt} IS NULL OR ${profiles.lastActiveAt} < ${week.toISOString()})`;
  return undefined;
}

function adminProfileWhere(eventId: string, query: NetworkingAdminProfileQuery, now: Date): SQL {
  const activity = query.activity;
  return and(
    eq(profiles.eventId, eventId),
    listedProfile(profiles),
    query.q
      ? sql`strpos(lower(${profiles.firstName}||' '||${profiles.lastName}||' '||${profiles.company}||' '||${profiles.jobTitle}||' '||${profiles.email}), lower(${query.q}))>0`
      : undefined,
    query.sector ? eq(profiles.sector, query.sector) : undefined,
    query.status ? eq(profiles.status, query.status as ProfileRow["status"]) : undefined,
    !activity || activity === "ALL"
      ? undefined
      : activity === "MATCHED"
        ? hasConnection(eventId)
        : activity === "MEETINGS"
          ? hasHoldingMeeting(eventId)
          : activityTier(activity, now),
  ) as SQL;
}

/** Match and holding-meeting counts of the given participants (a list page). */
async function profileListCounts(eventId: string, ids: readonly string[], db: DbExecutor) {
  if (!ids.length) return new Map<string, { matches: number; meetings: number }>();
  const rows = rowsOf<{ id: string; matches: number; meetings: number }>(await db.execute(sql`
    SELECT p.id, coalesce(c.matches,0)::int4 AS matches, coalesce(m.meetings,0)::int4 AS meetings
    FROM networking_profiles p
    LEFT JOIN (SELECT profile_id, count(*) AS matches FROM (
        SELECT profile_a_id AS profile_id FROM networking_connections WHERE event_id=${eventId} AND profile_a_id IN (${idList(ids)})
        UNION ALL SELECT profile_b_id FROM networking_connections WHERE event_id=${eventId} AND profile_b_id IN (${idList(ids)})) ends
      GROUP BY profile_id) c ON c.profile_id=p.id
    LEFT JOIN (SELECT profile_id, count(*) AS meetings FROM (
        SELECT requester_id AS profile_id FROM networking_meetings WHERE event_id=${eventId}
          AND status IN (${networkingMeetingStatusSql("holding")}) AND requester_id IN (${idList(ids)})
        UNION ALL SELECT recipient_id FROM networking_meetings WHERE event_id=${eventId}
          AND status IN (${networkingMeetingStatusSql("holding")}) AND recipient_id IN (${idList(ids)})) ends
      GROUP BY profile_id) m ON m.profile_id=p.id
    WHERE p.event_id=${eventId} AND p.id IN (${idList(ids)})`));
  return new Map(rows.map((row) => [row.id, { matches: Number(row.matches), meetings: Number(row.meetings) }]));
}

/**
 * The organizer's participant list: listed profiles matching the filters,
 * oldest first, one page with the total, and each row's matches (connections)
 * and meetings (not released).
 */
export async function listNetworkingAdminProfiles(
  eventId: string,
  query: NetworkingAdminProfileQuery,
  db: DbExecutor = getDb(),
  now = new Date(),
): Promise<{ items: NetworkingAdminProfile[]; total: number }> {
  const where = adminProfileWhere(eventId, query, now);
  const [rows, [count]] = await Promise.all([
    db.select().from(profiles).where(where)
      .orderBy(asc(profiles.createdAt), asc(profiles.id))
      .limit(query.limit).offset(offsetOf(query)),
    db.select({ total }).from(profiles).where(where),
  ]);
  const counts = await profileListCounts(eventId, rows.map((row) => row.id), db);
  return {
    items: rows.map((row) => ({
      ...row,
      matchCount: counts.get(row.id)?.matches ?? 0,
      meetingCount: counts.get(row.id)?.meetings ?? 0,
    })),
    total: count?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/**
 * Accent folding for the organizer's meeting search, the SQL side of
 * `foldNetworkingSearch`: every precomposed Latin letter with diacritics maps
 * to its lowercase base letter (uppercase ones too: lower() leaves them alone
 * under a C locale), and combining marks (decomposed text) and Arabic
 * diacritics are dropped, as NFD plus mark removal does in JavaScript.
 */
const FOLD = (() => {
  let from = "", to = "";
  for (const [start, end] of [[0xc0, 0x24f], [0x1e00, 0x1eff]] as const)
    for (let code = start; code <= end; code++) {
      const letter = String.fromCodePoint(code);
      const base = letter.normalize("NFD").replace(/\p{M}/gu, "");
      if (base !== letter && base.length === 1) {
        from += letter;
        to += base.toLowerCase();
      }
    }
  for (const [start, end] of [[0x300, 0x36f], [0x64b, 0x65f], [0x670, 0x670]] as const)
    for (let code = start; code <= end; code++) from += String.fromCodePoint(code);
  return { from, to };
})();

/** The search text as the organizer's meeting search compares it (JavaScript side). */
export function foldNetworkingSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
}
const foldedSql = (value: SQL) => sql`translate(lower(${value}), ${FOLD.from}, ${FOLD.to})`;

export type NetworkingAdminMeetingQuery = Partial<Page> & {
  /** Either participant's "first last company", accents and case folded. */
  q?: string;
  status?: string;
  tableId?: string;
  /** Meetings starting in [from, to): a day in the event timezone. */
  startsFrom?: Date;
  startsBefore?: Date;
};

/**
 * The organizer's meeting list: meetings matching the filters by start time
 * (then id), one page (all of them without a limit) with the total.
 */
export async function listNetworkingAdminMeetings(
  eventId: string,
  query: NetworkingAdminMeetingQuery,
  db: DbExecutor = getDb(),
) {
  const search = query.q ? foldNetworkingSearch(query.q) : "";
  const where = and(
    eq(meetings.eventId, eventId),
    query.status ? sql`${meetings.status}::text=${query.status}` : undefined,
    query.tableId ? eq(meetings.tableId, query.tableId) : undefined,
    query.startsFrom ? gte(meetings.startsAt, query.startsFrom) : undefined,
    query.startsBefore ? lt(meetings.startsAt, query.startsBefore) : undefined,
    search
      ? sql`EXISTS (SELECT 1 FROM networking_profiles sp WHERE sp.event_id=${eventId}
          AND sp.id IN (${meetings.requesterId}, ${meetings.recipientId})
          AND strpos(${foldedSql(sql`sp.first_name||' '||sp.last_name||' '||sp.company`)}, ${search})>0)`
      : undefined,
  );
  const page = db.select().from(meetings).where(where).orderBy(asc(meetings.startsAt), asc(meetings.id)).$dynamic();
  const [rows, [count]] = await Promise.all([
    query.limit ? page.limit(query.limit).offset(offsetOf({ page: query.page ?? 1, limit: query.limit })) : page,
    db.select({ total }).from(meetings).where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const reporter = alias(profiles, "reporter");
const reported = alias(profiles, "reported");

/**
 * The organizer's moderation queue: reports (optionally of one status),
 * newest first, one page (all of them without a limit) with the total, each
 * with its reporter, the reported participant and the reported message.
 */
export async function listNetworkingAdminReports(
  eventId: string,
  query: Partial<Page> & { status?: string },
  db: DbExecutor = getDb(),
) {
  const where = and(
    eq(reports.eventId, eventId),
    query.status ? eq(reports.status, query.status as (typeof reports.$inferSelect)["status"]) : undefined,
  );
  const page = db
    .select({ report: reports, reporter, profile: reported, message: messages })
    .from(reports)
    .leftJoin(reporter, and(eq(reporter.id, reports.reporterId), eq(reporter.eventId, reports.eventId)))
    .leftJoin(reported, and(eq(reported.id, reports.profileId), eq(reported.eventId, reports.eventId)))
    .leftJoin(messages, and(eq(messages.id, reports.messageId), eq(messages.eventId, reports.eventId)))
    .where(where)
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .$dynamic();
  const [rows, [count]] = await Promise.all([
    query.limit ? page.limit(query.limit).offset(offsetOf({ page: query.page ?? 1, limit: query.limit })) : page,
    db.select({ total }).from(reports).where(where),
  ]);
  return {
    items: rows.map((row) => ({ ...row.report, reporter: row.reporter, profile: row.profile, message: row.message })),
    total: count?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** A listed participant named in an export row; null when not listed (erased or gone). */
export type NetworkingExportPerson = { firstName: string; lastName: string; company: string } | null;
export type NetworkingParticipantExportRow = Pick<
  ProfileRow,
  "id" | "firstName" | "lastName" | "email" | "company" | "jobTitle" | "sector" | "status" | "visible" | "lastActiveAt"
> & NetworkingEngagementCounts;
export type NetworkingMatchExportRow = {
  id: string;
  profileAId: string;
  profileBId: string;
  createdAt: Date;
  a: NetworkingExportPerson;
  b: NetworkingExportPerson;
};
export type NetworkingMeetingExportRow = Pick<
  typeof meetings.$inferSelect,
  "id" | "requesterId" | "recipientId" | "startsAt" | "endsAt" | "tableId" | "status" | "message"
> & { requester: NetworkingExportPerson; recipient: NetworkingExportPerson; tableName: string | null };

const personA = alias(profiles, "person_a");
const personB = alias(profiles, "person_b");
type Person = typeof personA | typeof personB;
const person = <P extends Person>(p: P) => ({ firstName: p.firstName, lastName: p.lastName, company: p.company });
/** A left-joined person: null when the join found no listed profile. */
const personOf = (p: { firstName: string | null; lastName: string | null; company: string | null } | null): NetworkingExportPerson =>
  p?.firstName == null ? null : { firstName: p.firstName, lastName: p.lastName ?? "", company: p.company ?? "" };
/** Joins `p` as the listed participant `id` of the row's event. */
const listedAs = (p: Person, id: AnyColumn, eventId: AnyColumn) =>
  and(eq(p.id, id), eq(p.eventId, eventId), listedProfile(p));

async function exportIds(read: (tx: DbExecutor) => Promise<{ id: string }[]>) {
  return (await withExportStatementTimeout(read)).map((row) => row.id);
}

/** The participants export: listed profiles oldest first, with their engagement. */
export async function* networkingParticipantExportPages(
  eventId: string,
  options: ExportPageOptions = {},
): AsyncGenerator<NetworkingParticipantExportRow[]> {
  const ids = await exportIds((tx) =>
    tx.select({ id: profiles.id }).from(profiles)
      .where(and(eq(profiles.eventId, eventId), listedProfile(profiles)))
      .orderBy(asc(profiles.createdAt), asc(profiles.id)));
  yield* pagesByIds(ids, options, async (chunk, tx) => {
    const [rows, engagement] = await Promise.all([
      tx.select({
        id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, email: profiles.email,
        company: profiles.company, jobTitle: profiles.jobTitle, sector: profiles.sector, status: profiles.status,
        visible: profiles.visible, lastActiveAt: profiles.lastActiveAt,
      }).from(profiles).where(and(eq(profiles.eventId, eventId), inArray(profiles.id, chunk), listedProfile(profiles))),
      networkingParticipantEngagement(eventId, chunk, tx),
    ]);
    const none = { swipes: 0, likes: 0, matches: 0, messages: 0, meetings: 0, completedMeetings: 0 };
    return rows.map((row) => ({ ...row, ...(engagement.get(row.id) ?? none) }));
  }, (row) => row.id);
}

/** The matches export: connections oldest first, with both participants when listed. */
export async function* networkingMatchExportPages(
  eventId: string,
  options: ExportPageOptions = {},
): AsyncGenerator<NetworkingMatchExportRow[]> {
  const ids = await exportIds((tx) =>
    tx.select({ id: connections.id }).from(connections).where(eq(connections.eventId, eventId))
      .orderBy(asc(connections.createdAt), asc(connections.id)));
  yield* pagesByIds(ids, options, async (chunk, tx) =>
    (await tx.select({
      id: connections.id, profileAId: connections.profileAId, profileBId: connections.profileBId,
      createdAt: connections.createdAt, a: person(personA), b: person(personB),
    }).from(connections)
      .leftJoin(personA, listedAs(personA, connections.profileAId, connections.eventId))
      .leftJoin(personB, listedAs(personB, connections.profileBId, connections.eventId))
      .where(and(eq(connections.eventId, eventId), inArray(connections.id, chunk))))
      .map((row) => ({ ...row, a: personOf(row.a), b: personOf(row.b) })), (row) => row.id);
}

/** The meetings export: every meeting by start time (then id), with listed participants and the table name. */
export async function* networkingMeetingExportPages(
  eventId: string,
  options: ExportPageOptions = {},
): AsyncGenerator<NetworkingMeetingExportRow[]> {
  const ids = await exportIds((tx) =>
    tx.select({ id: meetings.id }).from(meetings).where(eq(meetings.eventId, eventId))
      .orderBy(asc(meetings.startsAt), asc(meetings.id)));
  yield* pagesByIds(ids, options, async (chunk, tx) =>
    (await tx.select({
      id: meetings.id, requesterId: meetings.requesterId, recipientId: meetings.recipientId,
      startsAt: meetings.startsAt, endsAt: meetings.endsAt, tableId: meetings.tableId,
      status: meetings.status, message: meetings.message,
      requester: person(personA), recipient: person(personB), tableName: networkingTables.name,
    }).from(meetings)
      .leftJoin(personA, listedAs(personA, meetings.requesterId, meetings.eventId))
      .leftJoin(personB, listedAs(personB, meetings.recipientId, meetings.eventId))
      .leftJoin(networkingTables, and(eq(networkingTables.id, meetings.tableId), eq(networkingTables.eventId, meetings.eventId)))
      .where(and(eq(meetings.eventId, eventId), inArray(meetings.id, chunk))))
      .map((row) => ({ ...row, requester: personOf(row.requester), recipient: personOf(row.recipient) })), (row) => row.id);
}
