import { sql, type AnyColumn, type SQL } from "drizzle-orm";

type Column = AnyColumn | SQL;

/** Compact SQL spelling only; discovery's spaced predicates stay at its call site. */
export function completeNetworkingProfile(profile: { firstName: Column; lastName: Column; company: Column; jobTitle: Column; sector: Column }) {
  return sql`btrim(${profile.firstName})<>'' AND btrim(${profile.lastName})<>'' AND btrim(${profile.company})<>'' AND btrim(${profile.jobTitle})<>'' AND btrim(${profile.sector})<>''`;
}

export function notNetworkingSelfEmail(email: Column, profileId: string, eventId: string) {
  return sql`lower(${email})<>(SELECT lower(email) FROM networking_profiles WHERE id=${profileId} AND event_id=${eventId})`;
}

/** Internal aliases are closed: no caller-controlled identifier is interpolated. */
export function activeNetworkingParticipant(profile: "p" | "peer", registration: "r" | "peer_registration") {
  return sql.raw(`${profile}.status='ACTIVE' AND ${profile}.consent AND ${profile}.withdrawn_at IS NULL AND ${registration}.networking_opt_in IS DISTINCT FROM false`);
}

/** The compact NOT EXISTS variant; never substitutes discovery's tuned NOT IN query. */
export function unblockedNetworkingPair(eventId: SQL, profileId: SQL | string, targetId: SQL) {
  return sql`NOT EXISTS (SELECT 1 FROM networking_blocks b WHERE b.event_id=${eventId} AND ((b.profile_id=${profileId} AND b.target_id=${targetId}) OR (b.profile_id=${targetId} AND b.target_id=${profileId})))`;
}

// Embedding enqueue/claim share these exact spellings. Maintenance intentionally
// uses @> instead and does not filter archived events when queuing reminders.
export function networkingEmbeddingEventAvailable() {
  return sql`c.config->>'enabled'='true' AND cl.active AND ev.status<>'ARCHIVED'`;
}

export function networkingEmbeddingRequiredModules() {
  return sql`'networking'=ANY(cl.enabled_modules) AND 'registrations'=ANY(cl.enabled_modules) AND 'emails'=ANY(cl.enabled_modules)`;
}
