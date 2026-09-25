import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import {
  networkingMeetings,
  networkingNotifications,
  networkingReservations,
} from "../schema/networking";

/**
 * Meeting lifecycle (plan 4.7): which statuses count as what, what each
 * transition does to the meeting's reservations, and what a notice may say.
 *
 * Reservations are 5-minute quanta, unique per (event, resource, quantum):
 * - PENDING holds its table (when one is allocated) and `hold:profile:<requester>`,
 *   so a requester has at most one pending request per slot. Participants are
 *   not booked until the request is accepted.
 * - PENDING_ALLOCATION and CONFIRMED hold both participants (`profile:<id>`)
 *   and, once allocated, the table or exhibitor representative.
 * - COMPLETED and NO_SHOW keep every reservation: the slot was used.
 * - CANCELLED, DECLINED and EXPIRED release every reservation, in the same
 *   transaction (or statement) that moves the meeting.
 */
export type NetworkingMeetingRow = typeof networkingMeetings.$inferSelect;
export type NetworkingMeetingStatus = NetworkingMeetingRow["status"];

export const NETWORKING_MEETING_GROUPS = {
  /** Still changeable: participants and organizers can cancel, reschedule or assign. */
  open: ["PENDING", "PENDING_ALLOCATION", "CONFIRMED"],
  /** Accepted by both participants, with or without a place yet. */
  accepted: ["PENDING_ALLOCATION", "CONFIRMED"],
  /** Waiting for the other participant or for a place. */
  awaiting: ["PENDING", "PENDING_ALLOCATION"],
  /** On the agenda as a planned or attended meeting. */
  booked: ["CONFIRMED", "COMPLETED", "NO_SHOW"],
  /** Keep their reservations. */
  holding: ["PENDING", "PENDING_ALLOCATION", "CONFIRMED", "COMPLETED", "NO_SHOW"],
  /** Released every reservation. */
  released: ["CANCELLED", "DECLINED", "EXPIRED"],
} as const satisfies Record<string, readonly NetworkingMeetingStatus[]>;
export type NetworkingMeetingGroup = keyof typeof NETWORKING_MEETING_GROUPS;

export function networkingMeetingIs(status: string, group: NetworkingMeetingGroup): boolean {
  return (NETWORKING_MEETING_GROUPS[group] as readonly string[]).includes(status);
}

/**
 * Status-only transitions. Allocating ones (request, accept, pending reschedule,
 * organizer assignment) claim resources through the allocation transaction instead.
 */
export const NETWORKING_MEETING_TRANSITIONS = {
  CANCEL: { from: NETWORKING_MEETING_GROUPS.open, to: "CANCELLED" },
  DECLINE: { from: ["PENDING"], to: "DECLINED" },
  EXPIRE: { from: ["PENDING"], to: "EXPIRED" },
  COMPLETED: { from: ["CONFIRMED"], to: "COMPLETED" },
  NO_SHOW: { from: ["CONFIRMED"], to: "NO_SHOW" },
} as const satisfies Record<string, { from: readonly NetworkingMeetingStatus[]; to: NetworkingMeetingStatus }>;
export type NetworkingMeetingTransition = keyof typeof NETWORKING_MEETING_TRANSITIONS;

/** The per-quantum key a pending request holds for its requester. */
export function networkingPendingHoldKey(requesterId: string) {
  return `hold:profile:${requesterId}`;
}

const statusList = (statuses: readonly string[]) => sql.join(statuses.map((status) => sql`${status}`), sql`,`);
/** A group as an SQL value list, for raw queries: `status IN (${networkingMeetingStatusSql("booked")})`. */
export const networkingMeetingStatusSql = (group: NetworkingMeetingGroup) => statusList(NETWORKING_MEETING_GROUPS[group]);

/**
 * Applies one transition to the event's meetings that `target` selects (ids, or
 * a predicate for callers in this package) and are in a source status, in one
 * UPDATE … RETURNING; then releases the reservations of exactly those rows when
 * the target status is released. Run it inside the caller's transaction.
 */
export async function transitionNetworkingMeetings(
  db: DbExecutor,
  transition: NetworkingMeetingTransition,
  eventId: string,
  target: readonly string[] | SQL,
  set: Partial<Pick<NetworkingMeetingRow, "cancellationNote" | "proposedStartsAt" | "proposalBy">> = {},
): Promise<NetworkingMeetingRow[]> {
  if (Array.isArray(target) && !target.length) return [];
  const { from, to } = NETWORKING_MEETING_TRANSITIONS[transition];
  const m = networkingMeetings;
  const rows = await db
    .update(m)
    .set({ ...set, status: to, revision: sql`${m.revision}+1` })
    .where(
      and(
        eq(m.eventId, eventId),
        inArray(m.status, [...from]),
        Array.isArray(target) ? inArray(m.id, [...target]) : (target as SQL),
      ),
    )
    .returning();
  if (rows.length && networkingMeetingIs(to, "released")) {
    const r = networkingReservations;
    await db.delete(r).where(and(eq(r.eventId, eventId), inArray(r.meetingId, rows.map((row) => row.id))));
  }
  return rows;
}

/**
 * Expires overdue pending requests and releases the reservations of exactly the
 * rows it expired, in one statement; then clears overdue counter-proposals.
 * Read paths call it outside a transaction, so it never sweeps history: the
 * released-reservation sweep belongs to maintenance.
 */
export async function expireNetworkingProposals(eventId?: string, db: DbExecutor = getDb()) {
  const scope = eventId ? sql`AND event_id=${eventId}` : sql``;
  const { from, to } = NETWORKING_MEETING_TRANSITIONS.EXPIRE;
  await db.execute(sql`
    WITH expired AS (
      UPDATE networking_meetings SET status=${to},revision=revision+1,updated_at=now()
      WHERE status IN (${statusList(from)}) AND expires_at<=now() ${scope}
      RETURNING id
    )
    DELETE FROM networking_reservations WHERE meeting_id IN (SELECT id FROM expired)`);
  await db.execute(
    sql`UPDATE networking_meetings SET proposed_starts_at=NULL,proposal_by=NULL,revision=revision+1,updated_at=now() WHERE proposed_starts_at IS NOT NULL AND expires_at<=now() ${scope}`,
  );
}

/**
 * Maintenance safety net: deletes reservations still attached to a released
 * meeting (rows released before per-transition releases, or by hand).
 */
export async function sweepReleasedNetworkingReservations(eventId?: string, db: DbExecutor = getDb()) {
  const scope = eventId ? sql`AND r.event_id=${eventId}` : sql``;
  await db.execute(sql`
    DELETE FROM networking_reservations r
    WHERE EXISTS (
      SELECT 1 FROM networking_meetings m
      WHERE m.id=r.meeting_id AND m.status IN (${statusList(NETWORKING_MEETING_GROUPS.released)})
    ) ${scope}`);
}

/** Notification type → the action the PWA and delivery worker read from `data.action`. */
export const NETWORKING_MEETING_NOTICE_ACTIONS: Record<string, string> = {
  MEETING_REQUEST: "REQUEST", MEETING_REQUEST_SENT: "REQUEST", MEETING_ACCEPT: "ACCEPT", MEETING_DECLINE: "DECLINE",
  MEETING_CANCEL: "CANCEL", MEETING_CANCELLED: "CANCEL", MEETING_RESCHEDULE: "RESCHEDULE", MEETING_ASSIGN: "ASSIGN",
  MEETING_COMPLETED: "COMPLETED", MEETING_NO_SHOW: "NO_SHOW",
};

/**
 * Why a meeting was cancelled, as its notices say it. UNAVAILABLE covers every
 * cancellation the other participant must not learn the cause of: a block, a
 * withdrawal, revoked consent or eligibility, and moderation.
 */
export type NetworkingMeetingCancelReason = "PARTICIPANT" | "ORGANIZER" | "UNAVAILABLE";

export interface NetworkingMeetingNoticeInput {
  type: string;
  slug: string;
  /** Required on cancellation notices (MEETING_CANCEL, MEETING_CANCELLED). */
  reason?: NetworkingMeetingCancelReason;
  /**
   * A confidential notice names neither the other participant nor the place and
   * always gives reason UNAVAILABLE, so the recipient cannot tell a block from a
   * withdrawal or a moderation decision.
   */
  confidential?: boolean;
  counterpartName?: string;
  tableName?: string;
  spaceName?: string;
}

/** The in-app notification (and delivery payload) one participant gets for a meeting change. */
export function networkingMeetingNotice(
  row: NetworkingMeetingRow,
  profileId: string,
  notice: NetworkingMeetingNoticeInput,
): typeof networkingNotifications.$inferInsert {
  const common = {
    eventId: row.eventId,
    profileId,
    type: notice.type,
    href: `/e/${notice.slug}/agenda`,
  };
  if (notice.confidential)
    return {
      ...common,
      title: "Meeting cancelled",
      body: "This meeting is no longer available.",
      data: {
        meetingId: row.id,
        revision: row.revision,
        action: "CANCEL",
        status: row.status,
        reason: "UNAVAILABLE",
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
      },
    };
  const action = NETWORKING_MEETING_NOTICE_ACTIONS[notice.type];
  const proposedEndsAt = row.proposedStartsAt
    ? new Date(row.proposedStartsAt.getTime() + row.endsAt.getTime() - row.startsAt.getTime())
    : null;
  return {
    ...common,
    title: "Meeting update",
    body: `Meeting ${row.status.toLowerCase().replaceAll("_", " ")} for ${row.startsAt.toISOString()}.`,
    data: {
      meetingId: row.id,
      revision: row.revision,
      ...(action ? { action } : {}),
      ...(action === "CANCEL" && notice.reason ? { reason: notice.reason } : {}),
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      ...(row.proposedStartsAt && proposedEndsAt
        ? { proposedStartsAt: row.proposedStartsAt.toISOString(), proposedEndsAt: proposedEndsAt.toISOString() }
        : {}),
      ...(notice.counterpartName ? { counterpartName: notice.counterpartName } : {}),
      ...(notice.tableName ? { tableName: notice.tableName } : {}),
      ...(notice.spaceName ? { spaceName: notice.spaceName } : {}),
      status: row.status,
    },
  };
}
