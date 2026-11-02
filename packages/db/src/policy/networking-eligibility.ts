import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { NETWORKING_REQUIRED_MODULES } from "./networking-access";

/**
 * SQL twins of the networking eligibility policy (`networking-access.ts`,
 * plan 4.6). Every query that filters participants composes these fragments
 * instead of spelling the rules out again; the fixture matrix checks each
 * query against the TypeScript policy on both engines.
 *
 * Column sources are Drizzle tables or aliases: in a raw statement write
 * `FROM networking_profiles p` and pass `alias(networkingProfiles, "p")`.
 * Plain strings passed as values are bound parameters, never SQL.
 */

type Column = AnyColumn | SQL | SQL.Aliased;
/** A value: a bound parameter (string), a column or an SQL expression. */
export type NetworkingSqlValue = string | Column;
export type NetworkingProfileColumns = Record<
  | "id"
  | "eventId"
  | "email"
  | "status"
  | "consent"
  | "withdrawnAt"
  | "erasedAt"
  | "visible"
  | "firstName"
  | "lastName"
  | "company"
  | "jobTitle"
  | "sector",
  Column
>;
export type NetworkingRegistrationColumns = Record<"eventId" | "paymentStatus" | "networkingOptIn", Column>;
/**
 * The event's eligible payment statuses: a list known to the caller, or the
 * `networking_configs.config` column when the statement spans events.
 */
export type NetworkingPaymentStatuses = readonly string[] | { config: Column };

function paymentStatusEligible(r: NetworkingRegistrationColumns, statuses: NetworkingPaymentStatuses): SQL {
  if ("config" in statuses) return sql`(${statuses.config}->'eligiblePaymentStatuses' ? ${r.paymentStatus}::text)`;
  if (!statuses.length) return sql`false`;
  return sql`${r.paymentStatus}::text IN (${sql.join(statuses.map((status) => sql`${status}`), sql`,`)})`;
}

/**
 * Consented and eligible (`networkingParticipantEligible`): an ACTIVE,
 * consented, never withdrawn or erased profile whose registration `r` (joined
 * by the caller on `r.id = p.registration_id`) belongs to the same event, did
 * not opt out and has an eligible payment status.
 */
export function eligibleProfile(
  p: NetworkingProfileColumns,
  r: NetworkingRegistrationColumns,
  statuses: NetworkingPaymentStatuses,
): SQL {
  return sql`(${p.status}='ACTIVE' AND ${p.consent} AND ${p.withdrawnAt} IS NULL AND ${p.erasedAt} IS NULL
    AND ${r.eventId}=${p.eventId} AND ${r.networkingOptIn} IS DISTINCT FROM false
    AND ${paymentStatusEligible(r, statuses)})`;
}

/** Consented, eligible and visible (`networkingProfileEmbeddable`): embedded for recommendations. */
export function embeddableProfile(
  p: NetworkingProfileColumns,
  r: NetworkingRegistrationColumns,
  statuses: NetworkingPaymentStatuses,
): SQL {
  return sql`(${eligibleProfile(p, r, statuses)} AND ${p.visible})`;
}

/** Every professional field discovery shows is filled (`networkingProfileComplete`). */
export function profileComplete(p: NetworkingProfileColumns): SQL {
  return sql`(btrim(${p.firstName})<>'' AND btrim(${p.lastName})<>'' AND btrim(${p.company})<>''
    AND btrim(${p.jobTitle})<>'' AND btrim(${p.sector})<>'')`;
}

/** Visible with a complete profile (`networkingProfileDiscoverable`). */
export function discoverableProfile(p: NetworkingProfileColumns): SQL {
  return sql`(${p.visible} AND ${profileComplete(p)})`;
}

/**
 * Not the viewer, nor another profile of the viewer's address
 * (`networkingDistinctIdentity`). `viewerEmail` defaults to a lookup of the
 * viewer's own row.
 */
export function distinctIdentity(
  p: NetworkingProfileColumns,
  viewer: { eventId: NetworkingSqlValue; profileId: NetworkingSqlValue; email?: Column },
): SQL {
  const viewerEmail = viewer.email
    ? sql`lower(btrim(${viewer.email}))`
    : sql`(SELECT lower(btrim(elig_v.email)) FROM networking_profiles elig_v WHERE elig_v.id=${viewer.profileId} AND elig_v.event_id=${viewer.eventId})`;
  return sql`(${p.id}<>${viewer.profileId} AND lower(btrim(${p.email}))<>${viewerEmail})`;
}

/** One of the participant's own profiles: the same address (`networkingIdentityEmail`). */
export function sameIdentity(p: Pick<NetworkingProfileColumns, "email">, email: string): SQL {
  return sql`lower(btrim(${p.email}))=lower(btrim(${email}))`;
}

/** No block in either direction between `a` and `b`. */
export function mutuallyUnblocked(eventId: NetworkingSqlValue, a: NetworkingSqlValue, b: NetworkingSqlValue): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM networking_blocks elig_b WHERE elig_b.event_id=${eventId}
    AND ((elig_b.profile_id=${a} AND elig_b.target_id=${b}) OR (elig_b.profile_id=${b} AND elig_b.target_id=${a})))`;
}

/** The viewer has not swiped the target and they are not connected (fresh recommendations). */
export function notInteracted(eventId: NetworkingSqlValue, viewerId: NetworkingSqlValue, targetId: NetworkingSqlValue): SQL {
  return sql`(NOT EXISTS (SELECT 1 FROM networking_interests elig_i WHERE elig_i.event_id=${eventId}
      AND elig_i.profile_id=${viewerId} AND elig_i.target_id=${targetId})
    AND NOT EXISTS (SELECT 1 FROM networking_connections elig_c WHERE elig_c.event_id=${eventId}
      AND ((elig_c.profile_a_id=${viewerId} AND elig_c.profile_b_id=${targetId}) OR (elig_c.profile_a_id=${targetId} AND elig_c.profile_b_id=${viewerId}))))`;
}

/** Counterpart in `discover` mode: eligible, distinct, unblocked and discoverable. */
export function discoverableCounterpart(
  p: NetworkingProfileColumns,
  r: NetworkingRegistrationColumns,
  statuses: NetworkingPaymentStatuses,
  viewer: { eventId: NetworkingSqlValue; profileId: NetworkingSqlValue },
): SQL {
  return sql`(${eligibleProfile(p, r, statuses)} AND ${discoverableProfile(p)} AND ${distinctIdentity(p, viewer)}
    AND ${mutuallyUnblocked(viewer.eventId, viewer.profileId, p.id)})`;
}

/**
 * Counterpart in `peer` mode: the relationship (connection, meeting) is
 * joined by the caller; the peer must be eligible, distinct and unblocked.
 */
export function peerCounterpart(
  p: NetworkingProfileColumns,
  r: NetworkingRegistrationColumns,
  statuses: NetworkingPaymentStatuses,
  viewer: { eventId: NetworkingSqlValue; profileId: NetworkingSqlValue; email?: Column },
): SQL {
  return sql`(${eligibleProfile(p, r, statuses)} AND ${distinctIdentity(p, viewer)}
    AND ${mutuallyUnblocked(viewer.eventId, viewer.profileId, p.id)})`;
}

/** `a` and `b` are connected (a connection stores its pair in either column order). */
export function connectedPair(eventId: NetworkingSqlValue, a: NetworkingSqlValue, b: NetworkingSqlValue): SQL {
  return sql`EXISTS (SELECT 1 FROM networking_connections elig_pc WHERE elig_pc.event_id=${eventId}
    AND ((elig_pc.profile_a_id=${a} AND elig_pc.profile_b_id=${b}) OR (elig_pc.profile_a_id=${b} AND elig_pc.profile_b_id=${a})))`;
}

/**
 * Counterpart in `profile` mode (a profile the viewer opens: incoming
 * interests, meeting counterparts): a peer that is discoverable while the
 * event's discovery is on, or connected to the viewer. `discoveryEnabled` is
 * `networkingDiscoveryEnabled(config)`, decided by the caller.
 */
export function profileCounterpart(
  p: NetworkingProfileColumns,
  r: NetworkingRegistrationColumns,
  statuses: NetworkingPaymentStatuses,
  viewer: { eventId: NetworkingSqlValue; profileId: NetworkingSqlValue; email?: Column },
  discoveryEnabled: boolean,
): SQL {
  const discoverable = discoveryEnabled ? discoverableProfile(p) : sql`false`;
  return sql`(${peerCounterpart(p, r, statuses, viewer)}
    AND (${discoverable} OR ${connectedPair(viewer.eventId, viewer.profileId, p.id)}))`;
}

/**
 * Admitted to the networking area: eligible, with at least one confirmed
 * meeting (check-in scans and the participant's badge).
 */
export function admittedProfile(
  p: NetworkingProfileColumns,
  r: NetworkingRegistrationColumns,
  statuses: NetworkingPaymentStatuses,
): SQL {
  return sql`(${eligibleProfile(p, r, statuses)} AND EXISTS (SELECT 1 FROM networking_meetings elig_m
    WHERE elig_m.event_id=${p.eventId} AND elig_m.status='CONFIRMED' AND (elig_m.requester_id=${p.id} OR elig_m.recipient_id=${p.id})))`;
}

/** `networkingEventAvailable`: enabled, event not archived, client active with the required modules. */
export function networkingEventGate(sources: {
  config: Column;
  eventStatus: Column;
  clientActive: Column;
  clientModules: Column;
}): SQL {
  const modules = sql.join(NETWORKING_REQUIRED_MODULES.map((module) => sql`${module}`), sql`,`);
  return sql`(${sources.config}->>'enabled'='true' AND ${sources.eventStatus}<>'ARCHIVED'
    AND ${sources.clientActive} AND ${sources.clientModules} @> ARRAY[${modules}]::text[])`;
}

/** `networkingProfileListed`: not an erased tombstone. */
export function listedProfile(p: Pick<NetworkingProfileColumns, "erasedAt">): SQL {
  return sql`${p.erasedAt} IS NULL`;
}

/**
 * `networkingProfileActive`: counted as an active participant in organizer
 * analytics (ACTIVE, consented, never withdrawn or erased; no registration check).
 */
export function activeProfile(p: Pick<NetworkingProfileColumns, "status" | "consent" | "withdrawnAt" | "erasedAt">): SQL {
  return sql`(${p.status}='ACTIVE' AND ${p.consent} AND ${p.withdrawnAt} IS NULL AND ${p.erasedAt} IS NULL)`;
}
