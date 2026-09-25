import { and, eq, getTableName, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { NETWORKING_PROFESSIONAL_FIELDS } from "@app/contracts";
import { createLogger } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { rowCountOf, rowsOf } from "../helpers";
import { withSerializableTxn } from "../txn";
import * as n from "../schema/networking";
import { networkingEmbeddingJobs, networkingEmbeddings } from "../schema/networking-embeddings";
import { networkingSecondFactors } from "../schema/networking-mfa";
import { emailLogs } from "../schema/email";
import { cancelNetworkingParticipantMeetings, revokeNetworkingSessions } from "./networking";
import { NETWORKING_PURGE_KEPT_AUDIT_ACTIONS } from "./networking-retention";
import { enqueueNetworkingPhotoDeletes } from "./storage-delete";

const log = createLogger({ name: "db:networking-erasure" });

type ProfileRow = typeof n.networkingProfiles.$inferSelect;
type ProfileColumn = keyof ProfileRow;
/** A column the tombstone keeps, or the value that replaces it on erasure. */
type ColumnFate<K extends ProfileColumn> = "keep" | { scrub: ProfileRow[K] };

/**
 * Every `networking_profiles` column, kept on the tombstone or scrubbed.
 * An erased profile stays as a row (the tombstone) so registration sync finds
 * it and never recreates the participant; nothing personal remains on it. A
 * schema-derived test fails until a new column is classified here.
 */
export const NETWORKING_PROFILE_TOMBSTONE: { readonly [K in ProfileColumn]: ColumnFate<K> } = {
  id: "keep",
  eventId: "keep",
  // The tombstone's key: sync looks the profile up by registration.
  registrationId: "keep",
  withdrawnAt: "keep",
  // Stamped by the erasure itself.
  erasedAt: "keep",
  createdAt: "keep",
  updatedAt: "keep",
  email: { scrub: "" },
  firstName: { scrub: "" },
  lastName: { scrub: "" },
  company: { scrub: "" },
  jobTitle: { scrub: "" },
  sector: { scrub: "" },
  bio: { scrub: "" },
  city: { scrub: "" },
  country: { scrub: "" },
  website: { scrub: null },
  photoUrl: { scrub: null },
  interests: { scrub: [] },
  offers: { scrub: "" },
  seeks: { scrub: "" },
  // Terminal: nothing reactivates an excluded profile; any earlier moderation outcome is not kept.
  status: { scrub: "EXCLUDED" },
  visible: { scrub: false },
  meetingsEnabled: { scrub: false },
  emailPreference: { scrub: "OFF" },
  language: { scrub: "fr" },
  consent: { scrub: false },
  availabilitySet: { scrub: false },
  consentAt: { scrub: null },
  lastActiveAt: { scrub: null },
  featured: { scrub: false },
  standTableId: { scrub: null },
  overrides: { scrub: {} },
};

type ProfilePatch = Partial<typeof n.networkingProfiles.$inferInsert>;
function scrubbed(columns: readonly ProfileColumn[]): ProfilePatch {
  return Object.fromEntries(columns.map((column) => {
    const fate = NETWORKING_PROFILE_TOMBSTONE[column];
    if (fate === "keep") throw new Error(`networking_profiles.${column} is kept on the tombstone`);
    return [column, fate.scrub];
  })) as ProfilePatch;
}
const tombstoneColumns = (Object.keys(NETWORKING_PROFILE_TOMBSTONE) as ProfileColumn[])
  .filter((column) => NETWORKING_PROFILE_TOMBSTONE[column] !== "keep");

/**
 * Cleared the moment a participant withdraws: everything they wrote or chose
 * for networking. Name, email, status and timestamps stay until the erasure,
 * so the organizer can still handle reports during the window and the erasure
 * can find the email-keyed rows (codes, email logs).
 */
export const NETWORKING_WITHDRAWAL_SCRUBBED_COLUMNS = [
  ...NETWORKING_PROFESSIONAL_FIELDS,
  "overrides",
  "consent",
  "visible",
  "meetingsEnabled",
  "availabilitySet",
  "featured",
  "emailPreference",
] as const satisfies readonly ProfileColumn[];

/**
 * Withdrawal (DELETE /me), inside the caller's networking transaction:
 * scrub the profile content, revoke sessions, cancel open meetings, and
 * delete push subscriptions, availability, embeddings and every delivery
 * not yet sent. The photo is queued for durable deletion. The rest is erased
 * after NETWORKING_WITHDRAWAL_ERASE_DAYS by `eraseWithdrawnNetworkingProfiles`.
 */
export async function withdrawNetworkingProfile(
  db: DbExecutor,
  input: { eventId: string; profileId: string; slug?: string },
): Promise<void> {
  const profiles = n.networkingProfiles;
  const where = and(eq(profiles.id, input.profileId), eq(profiles.eventId, input.eventId));
  // The in-transaction row is authoritative for the photo to delete.
  const [current] = await db.select({ photoUrl: profiles.photoUrl }).from(profiles).where(where);
  if (!current) return;
  await db.update(profiles)
    .set({ ...scrubbed(NETWORKING_WITHDRAWAL_SCRUBBED_COLUMNS), withdrawnAt: new Date(), updatedAt: new Date() })
    .where(where);
  await revokeNetworkingSessions(input.profileId, db);
  // One UPDATE … RETURNING over this participant's active meetings; notices never name the other side (K5).
  await cancelNetworkingParticipantMeetings(input.profileId, input.eventId, db, { slug: input.slug });
  const own = (table: PgTable & { profileId: PgColumn }) => sql`DELETE FROM ${table} WHERE ${table.profileId}=${input.profileId}`;
  await db.execute(own(n.networkingPushSubscriptions));
  await db.execute(own(n.networkingAvailability));
  await db.execute(own(networkingEmbeddings));
  await db.execute(own(networkingEmbeddingJobs));
  // After the cancellation, whose notices include this participant's own copy.
  const deliveries = n.networkingDeliveries;
  await db.execute(sql`DELETE FROM ${deliveries} WHERE ${deliveries.profileId}=${input.profileId} AND ${deliveries.status} IN ('PENDING','PROCESSING','FAILED')`);
  // Durable: the storage.delete row commits with the withdrawal and the worker
  // retries it; the handler deletes only a key under the participant's own prefix.
  await enqueueNetworkingPhotoDeletes(db, [{ id: input.profileId, eventId: input.eventId, photoUrl: current.photoUrl }], "networking.withdrawal");
}

export interface NetworkingErasureTarget {
  profileId: string;
  eventId: string;
  /** The profile's email before erasure: its codes and email logs are keyed by it. */
  email: string;
}
type EraseBatch = (db: DbExecutor, target: NetworkingErasureTarget, limit: number) => Promise<number>;
export interface NetworkingErasureStep {
  /** Stable name for logs and results (the SQL table name). */
  name: string;
  table: PgTable;
  /** The foreign keys to networking_profiles this step clears (checked against the schema). */
  covers: readonly PgColumn[];
  batch: EraseBatch;
}

/** Up to `limit` rows matching `where`, deleted by primary key. */
function deleteRows(table: PgTable, key: PgColumn, where: (target: NetworkingErasureTarget) => SQL): EraseBatch {
  return async (db, target, limit) => rowCountOf(await db.execute(sql`
    DELETE FROM ${table} WHERE ${key} IN (
      SELECT ${key} FROM ${table} WHERE ${where(target)} LIMIT ${limit}
    )`));
}
const m = n.networkingMeetings;
const c = n.networkingConnections;
const r = n.networkingReports;
const meetingsOf = ({ eventId, profileId }: NetworkingErasureTarget) =>
  sql`SELECT ${m.id} FROM ${m} WHERE ${m.eventId}=${eventId} AND (${m.requesterId}=${profileId} OR ${m.recipientId}=${profileId})`;
const connectionsOf = ({ eventId, profileId }: NetworkingErasureTarget) =>
  sql`SELECT ${c.id} FROM ${c} WHERE ${c.eventId}=${eventId} AND (${c.profileAId}=${profileId} OR ${c.profileBId}=${profileId})`;
const reportsOf = ({ eventId, profileId }: NetworkingErasureTarget) =>
  sql`SELECT ${r.id} FROM ${r} WHERE ${r.eventId}=${eventId} AND (${r.reporterId}=${profileId} OR ${r.profileId}=${profileId})`;
/** Rows of this event keyed by the profile on any of `columns`. */
function byProfile(table: PgTable, key: PgColumn, event: PgColumn, columns: readonly PgColumn[]): NetworkingErasureStep {
  return {
    name: getTableName(table),
    table,
    covers: columns,
    batch: deleteRows(table, key, (target) =>
      sql`${event}=${target.eventId} AND (${sql.join(columns.map((column) => sql`${column}=${target.profileId}`), sql` OR `)})`),
  };
}
/** Tables without an event_id, keyed by the profile alone. */
function byProfileOnly(table: PgTable, key: PgColumn): NetworkingErasureStep {
  return { name: getTableName(table), table, covers: [key], batch: deleteRows(table, key, (target) => sql`${key}=${target.profileId}`) };
}
const notifications = n.networkingNotifications;
const deliveries = n.networkingDeliveries;
const audit = n.networkingAudit;
const challenges = n.networkingChallenges;
const tables = n.networkingTables;
const messages = n.networkingMessages;
const reservations = n.networkingReservations;
const sameEmail = (column: PgColumn, email: string) => email ? sql`lower(${column})=${email.toLowerCase()}` : sql`FALSE`;

/**
 * The erasure after the withdrawal window, per profile, children before
 * parents, reads of meetings/connections/reports before their rows go. Every
 * foreign key to networking_profiles is listed in some step's `covers` (a test
 * derives them from the schema). The profile row itself becomes the tombstone.
 */
export const NETWORKING_ERASURE_STEPS: readonly NetworkingErasureStep[] = [
  {
    // Participant activity by or about them, and organizer entries on their meetings and reports.
    name: getTableName(audit), table: audit, covers: [],
    batch: deleteRows(audit, audit.id, (target) => sql`${audit.eventId}=${target.eventId}
      AND ${audit.action} NOT IN (${sql.join(NETWORKING_PURGE_KEPT_AUDIT_ACTIONS.map((action) => sql`${action}`), sql`,`)})
      AND (${audit.actorId}=${target.profileId} OR ${audit.targetId}=${target.profileId}
        OR ${audit.targetId} IN (${meetingsOf(target)}) OR ${audit.targetId} IN (${reportsOf(target)}))`),
  },
  {
    // Their notifications, and other participants' notices naming them (connection or meeting).
    name: getTableName(notifications), table: notifications, covers: [notifications.profileId],
    batch: deleteRows(notifications, notifications.id, (target) => sql`${notifications.eventId}=${target.eventId}
      AND (${notifications.profileId}=${target.profileId}
        OR ${notifications.data}->>'connectionId' IN (${connectionsOf(target)})
        OR ${notifications.data}->>'meetingId' IN (${meetingsOf(target)}))`),
  },
  {
    name: getTableName(deliveries), table: deliveries, covers: [deliveries.profileId],
    batch: deleteRows(deliveries, deliveries.id, (target) => sql`${deliveries.eventId}=${target.eventId}
      AND (${deliveries.profileId}=${target.profileId}
        OR ${deliveries.payload}->>'connectionId' IN (${connectionsOf(target)})
        OR ${deliveries.payload}->>'meetingId' IN (${meetingsOf(target)}))`),
  },
  {
    // Networking emails sent to them (index email_logs_networking_event_idx, 0026).
    name: getTableName(emailLogs), table: emailLogs, covers: [],
    batch: deleteRows(emailLogs, emailLogs.id, (target) => sql`(${emailLogs.contextSnapshot} ->> 'dispatchOwner') = 'networking'
      AND (${emailLogs.contextSnapshot} ->> 'eventId') = ${target.eventId}
      AND ((${emailLogs.contextSnapshot} ->> 'profileId') = ${target.profileId} OR ${sameEmail(emailLogs.recipientEmail, target.email)})`),
  },
  {
    name: getTableName(reservations), table: reservations, covers: [],
    batch: deleteRows(reservations, reservations.id, (target) =>
      sql`${reservations.eventId}=${target.eventId} AND ${reservations.meetingId} IN (${meetingsOf(target)})`),
  },
  byProfile(m, m.id, m.eventId, [m.requesterId, m.recipientId]),
  byProfile(r, r.id, r.eventId, [r.reporterId, r.profileId]),
  {
    // Whole conversations: every message of their connections, whoever sent it.
    name: getTableName(messages), table: messages, covers: [messages.senderId],
    batch: deleteRows(messages, messages.id, (target) => sql`${messages.eventId}=${target.eventId}
      AND (${messages.senderId}=${target.profileId} OR ${messages.connectionId} IN (${connectionsOf(target)}))`),
  },
  byProfile(c, c.id, c.eventId, [c.profileAId, c.profileBId]),
  byProfile(n.networkingInterests, n.networkingInterests.id, n.networkingInterests.eventId, [n.networkingInterests.profileId, n.networkingInterests.targetId]),
  byProfile(n.networkingBlocks, n.networkingBlocks.id, n.networkingBlocks.eventId, [n.networkingBlocks.profileId, n.networkingBlocks.targetId]),
  byProfile(n.networkingAvailability, n.networkingAvailability.id, n.networkingAvailability.eventId, [n.networkingAvailability.profileId]),
  byProfile(n.networkingPushSubscriptions, n.networkingPushSubscriptions.id, n.networkingPushSubscriptions.eventId, [n.networkingPushSubscriptions.profileId]),
  byProfile(n.networkingSessions, n.networkingSessions.id, n.networkingSessions.eventId, [n.networkingSessions.profileId]),
  {
    name: getTableName(challenges), table: challenges, covers: [],
    batch: deleteRows(challenges, challenges.id, (target) =>
      sql`${challenges.eventId}=${target.eventId} AND ${sameEmail(challenges.email, target.email)}`),
  },
  byProfile(networkingEmbeddings, networkingEmbeddings.id, networkingEmbeddings.eventId, [networkingEmbeddings.profileId]),
  byProfileOnly(networkingEmbeddingJobs, networkingEmbeddingJobs.profileId),
  byProfileOnly(networkingSecondFactors, networkingSecondFactors.profileId),
  {
    // Organizer inventory stays; only the stand's representative link goes.
    name: getTableName(tables), table: tables, covers: [tables.ownerProfileId],
    batch: async (db, target, limit) => rowCountOf(await db.execute(sql`
      UPDATE ${tables} SET owner_profile_id=NULL, updated_at=now() WHERE ${tables.id} IN (
        SELECT ${tables.id} FROM ${tables} WHERE ${tables.eventId}=${target.eventId} AND ${tables.ownerProfileId}=${target.profileId} LIMIT ${limit}
      )`)),
  },
];

/** Rows per erasure statement: small enough for a short transaction on either engine. */
export const NETWORKING_ERASURE_BATCH_SIZE = 500;

export interface NetworkingErasureResult {
  profileId: string;
  /** Null when the profile no longer exists (its registration was deleted): nothing to erase. */
  eventId: string | null;
  /** False when the deadline stopped it; the next call resumes (every step is idempotent). */
  done: boolean;
  /** True once the profile is a tombstone (now or before). */
  erased: boolean;
  deleted: Record<string, number>;
}

/**
 * Erase a withdrawn profile: every row about it, `batchSize` rows per
 * statement, then the profile row is scrubbed to its tombstone and
 * `erased_at` stamped, last. Refuses a profile that has not withdrawn.
 * `onBatch` sees every batch's count (the operator script logs them).
 */
export async function eraseNetworkingProfile(
  profileId: string,
  options: {
    batchSize?: number;
    /** Epoch ms; checked before every batch. */
    deadline?: number;
    onBatch?: (table: string, count: number) => void;
  } = {},
): Promise<NetworkingErasureResult> {
  const db = getDb();
  const profiles = n.networkingProfiles;
  const [profile] = await db
    .select({ eventId: profiles.eventId, email: profiles.email, withdrawnAt: profiles.withdrawnAt, erasedAt: profiles.erasedAt })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  const deleted: Record<string, number> = {};
  if (!profile) return { profileId, eventId: null, done: true, erased: false, deleted };
  if (!profile.withdrawnAt) throw new Error(`Networking profile ${profileId} has not withdrawn; refusing to erase it`);
  const result = (done: boolean, erased: boolean) => ({ profileId, eventId: profile.eventId, done, erased, deleted });
  if (profile.erasedAt) return result(true, true);
  const batchSize = options.batchSize ?? NETWORKING_ERASURE_BATCH_SIZE;
  const target = { profileId, eventId: profile.eventId, email: profile.email };
  for (const step of NETWORKING_ERASURE_STEPS) {
    for (;;) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) return result(false, false);
      const count = await step.batch(db, target, batchSize);
      if (count) deleted[step.name] = (deleted[step.name] ?? 0) + count;
      options.onBatch?.(step.name, count);
      if (count < batchSize) break;
    }
  }
  await withSerializableTxn(async (tx) => {
    const where = and(eq(profiles.id, profileId), isNotNull(profiles.withdrawnAt), isNull(profiles.erasedAt));
    const [row] = await tx.select({ photoUrl: profiles.photoUrl }).from(profiles).where(where);
    if (!row) return;
    // Withdrawal already queued it; a photo left by older code goes durably too.
    await enqueueNetworkingPhotoDeletes(tx, [{ id: profileId, eventId: profile.eventId, photoUrl: row.photoUrl }], "networking.erasure");
    await tx.update(profiles).set({ ...scrubbed(tombstoneColumns), erasedAt: new Date(), updatedAt: new Date() }).where(where);
  });
  options.onBatch?.(getTableName(profiles), 1);
  return result(true, true);
}

/** Withdrawn more than `eraseDays` ago and not yet erased, oldest first (index networking_profiles_withdrawn_idx). */
export async function networkingProfilesToErase(options: {
  eraseDays: number;
  eventId?: string;
  limit?: number;
}): Promise<Array<{ profileId: string; eventId: string; withdrawnAt: Date }>> {
  return rowsOf<{ id: string; event_id: string; withdrawn_at: Date | string }>(await getDb().execute(sql`
    SELECT id, event_id, withdrawn_at FROM networking_profiles
    WHERE withdrawn_at IS NOT NULL AND erased_at IS NULL AND withdrawn_at < now() - interval '1 day'*${options.eraseDays}::int
      ${options.eventId ? sql`AND event_id=${options.eventId}` : sql``}
    ORDER BY withdrawn_at, id LIMIT ${options.limit ?? 100}`))
    .map((row) => ({ profileId: row.id, eventId: row.event_id, withdrawnAt: new Date(row.withdrawn_at) }));
}

/** Maintenance: erase profiles past the withdrawal window within a time budget; the next run resumes. */
export async function eraseWithdrawnNetworkingProfiles(options: {
  eraseDays: number;
  eventId?: string;
  budgetMs?: number;
  batchSize?: number;
  limit?: number;
  onBatch?: (profileId: string, table: string, count: number) => void;
}): Promise<NetworkingErasureResult[]> {
  const deadline = Date.now() + (options.budgetMs ?? 15_000);
  const results: NetworkingErasureResult[] = [];
  for (const { profileId } of await networkingProfilesToErase(options)) {
    if (Date.now() >= deadline) break;
    const result = await eraseNetworkingProfile(profileId, {
      deadline,
      batchSize: options.batchSize,
      onBatch: options.onBatch && ((table, count) => options.onBatch!(profileId, table, count)),
    });
    results.push(result);
    log.info({ profileId, eventId: result.eventId, done: result.done, deleted: result.deleted }, "Networking withdrawal erasure");
    if (!result.done) break;
  }
  return results;
}
