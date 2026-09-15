import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { NetworkingConfig } from "@app/contracts";
import { idPk, timestamps } from "../helpers";
import { events } from "./events-access";
import { registrations } from "./registrations";
const eventId = () =>
  text()
    .notNull()
    .references(() => events.id, { onDelete: "cascade" });
const instant = () => timestamp({ precision: 3, withTimezone: true });
export const networkingConfigs = pgTable("networking_configs", {
  eventId: eventId().primaryKey(),
  config: jsonb().$type<NetworkingConfig>().notNull(),
  ...timestamps,
});
export const networkingProfiles = pgTable(
  "networking_profiles",
  {
    id: idPk(),
    eventId: eventId(),
    registrationId: text()
      .notNull()
      .references(() => registrations.id, { onDelete: "cascade" }),
    email: text().notNull(),
    firstName: text().notNull().default(""),
    lastName: text().notNull().default(""),
    company: text().notNull().default(""),
    jobTitle: text().notNull().default(""),
    sector: text().notNull().default(""),
    bio: text().notNull().default(""),
    city: text().notNull().default(""),
    country: text().notNull().default(""),
    website: text(),
    photoUrl: text(),
    interests: jsonb().$type<string[]>().notNull().default([]),
    offers: text().notNull().default(""),
    seeks: text().notNull().default(""),
    status: text()
      .$type<"PENDING" | "ACTIVE" | "SUSPENDED" | "EXCLUDED">()
      .notNull()
      .default("PENDING"),
    visible: boolean().notNull().default(true),
    meetingsEnabled: boolean().notNull().default(true),
    emailPreference: text()
      .$type<"IMMEDIATE" | "DAILY" | "OFF">()
      .notNull()
      .default("IMMEDIATE"),
    language: text().$type<"fr" | "en" | "ar">().notNull().default("fr"),
    consent: boolean().notNull().default(true),
    availabilitySet: boolean().notNull().default(false),
    consentAt: instant(),
    lastActiveAt: instant(),
    withdrawnAt: instant(),
    featured: boolean().notNull().default(false),
    standTableId: text(),
    overrides: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("networking_profiles_registration_key").on(t.registrationId),
    index("networking_profiles_event_status_idx").on(t.eventId, t.status),
    index("networking_profiles_event_email_idx").on(t.eventId, t.email),
    index("networking_profiles_stand_idx").on(t.eventId, t.standTableId),
    index("networking_profiles_embedding_scan_idx").on(t.updatedAt, t.id)
      .where(sql`${t.status}='ACTIVE' AND ${t.visible} AND ${t.consent} AND ${t.withdrawnAt} IS NULL`),
  ],
);
export const networkingChallenges = pgTable(
  "networking_challenges",
  {
    id: idPk(),
    eventId: eventId(),
    email: text().notNull(),
    codeHash: text().notNull(),
    expiresAt: instant().notNull(),
    attempts: integer().notNull().default(0),
    consumedAt: instant(),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    index("networking_challenges_email_created_idx").on(
      t.eventId,
      t.email,
      t.createdAt,
    ),
  ],
);
export const networkingSessions = pgTable(
  "networking_sessions",
  {
    id: idPk(),
    eventId: eventId(),
    profileId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    secondFactorVerifiedAt: instant(),
    expiresAt: instant().notNull(),
    revokedAt: instant(),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("networking_sessions_token_key").on(t.tokenHash),
    index("networking_sessions_profile_idx").on(t.profileId),
  ],
);
export const networkingInterests = pgTable(
  "networking_interests",
  {
    id: idPk(),
    eventId: eventId(),
    profileId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    targetId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    action: text().$type<"LIKE" | "PASS">().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("networking_interests_pair_key").on(
      t.eventId,
      t.profileId,
      t.targetId,
    ),
  ],
);
export const networkingConnections = pgTable(
  "networking_connections",
  {
    id: idPk(),
    eventId: eventId(),
    profileAId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    profileBId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    readAAt: instant(),
    readBAt: instant(),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    index("networking_connections_reverse_pair_idx").on(t.eventId, t.profileBId, t.profileAId),
    uniqueIndex("networking_connections_pair_key").on(
      t.eventId,
      t.profileAId,
      t.profileBId,
    ),
  ],
);
export const networkingMessages = pgTable(
  "networking_messages",
  {
    id: idPk(),
    eventId: eventId(),
    connectionId: text()
      .notNull()
      .references(() => networkingConnections.id, { onDelete: "cascade" }),
    senderId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    body: text().notNull(),
    clientMessageId: text().notNull(),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("networking_messages_client_key").on(
      t.senderId,
      t.clientMessageId,
    ),
    index("networking_messages_connection_created_idx").on(
      t.connectionId,
      t.createdAt,
    ),
  ],
);
export const networkingBlocks = pgTable(
  "networking_blocks",
  {
    id: idPk(),
    eventId: eventId(),
    profileId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    targetId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    index("networking_blocks_target_profile_idx").on(t.eventId, t.targetId, t.profileId),
    uniqueIndex("networking_blocks_pair_key").on(
      t.eventId,
      t.profileId,
      t.targetId,
    ),
  ],
);
export const networkingReports = pgTable(
  "networking_reports",
  {
    id: idPk(),
    eventId: eventId(),
    reporterId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    profileId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    messageId: text().references(() => networkingMessages.id, {
      onDelete: "set null",
    }),
    reason: text().notNull(),
    status: text()
      .$type<"OPEN" | "RESOLVED" | "DISMISSED">()
      .notNull()
      .default("OPEN"),
    note: text(),
    resolvedBy: text(),
    resolvedAt: instant(),
    ...timestamps,
  },
  (t) => [index("networking_reports_event_status_idx").on(t.eventId, t.status)],
);
export const networkingSpaces = pgTable(
  "networking_spaces",
  {
    id: idPk(),
    eventId: eventId(),
    name: text().notNull(),
    kind: text().$type<"TABLE" | "STAND">().notNull().default("TABLE"),
    capacity: integer().notNull().default(1),
    location: text().notNull().default(""),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("networking_spaces_event_name_key").on(t.eventId, t.name),
    check("networking_spaces_capacity_check", sql`${t.capacity} BETWEEN 1 AND 500`),
    check("networking_spaces_kind_check", sql`${t.kind} IN ('TABLE', 'STAND')`),
  ],
);
export const networkingTables = pgTable(
  "networking_tables",
  {
    id: idPk(),
    eventId: eventId(),
    spaceId: text().references(() => networkingSpaces.id, { onDelete: "cascade" }),
    name: text().notNull(),
    capacity: integer().notNull().default(2),
    location: text().notNull().default(""),
    active: boolean().notNull().default(true),
    kind: text().$type<"TABLE" | "STAND">().notNull().default("TABLE"),
    ownerProfileId: text().references(() => networkingProfiles.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("networking_tables_space_name_key").on(t.spaceId, t.name),
    index("networking_tables_event_space_idx").on(t.eventId, t.spaceId),
    check("networking_tables_two_people_check", sql`${t.capacity} = 2`),
  ],
);
export const networkingAvailability = pgTable(
  "networking_availability",
  {
    id: idPk(),
    eventId: eventId(),
    profileId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    startsAt: instant().notNull(),
  },
  (t) => [
    uniqueIndex("networking_availability_slot_key").on(t.profileId, t.startsAt),
  ],
);
export const networkingMeetings = pgTable(
  "networking_meetings",
  {
    id: idPk(),
    eventId: eventId(),
    requesterId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    recipientId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    startsAt: instant().notNull(),
    endsAt: instant().notNull(),
    tableId: text().references(() => networkingTables.id, {
      onDelete: "restrict",
    }),
    status: text()
      .$type<
        | "PENDING"
        | "PENDING_ALLOCATION"
        | "CONFIRMED"
        | "DECLINED"
        | "CANCELLED"
        | "EXPIRED"
        | "COMPLETED"
        | "NO_SHOW"
      >()
      .notNull()
      .default("PENDING"),
    message: text().notNull().default(""),
    cancellationNote: text().notNull().default(""),
    proposedStartsAt: instant(),
    proposalBy: text(),
    expiresAt: instant().notNull(),
    revision: integer().notNull().default(1),
    requesterCheckedInAt: instant(),
    recipientCheckedInAt: instant(),
    ...timestamps,
  },
  (t) => [
    index("networking_meetings_event_starts_idx").on(t.eventId, t.startsAt),
    index("networking_meetings_pending_idx").on(t.status, t.expiresAt),
  ],
);
// Five-minute resource quanta protect overlaps across edits to configured slot duration.
// Tables are exclusive pairs; exhibitor stations reserve each representative independently.
export const networkingReservations = pgTable(
  "networking_reservations",
  {
    id: idPk(),
    eventId: eventId(),
    meetingId: text()
      .notNull()
      .references(() => networkingMeetings.id, { onDelete: "cascade" }),
    resourceKey: text().notNull(),
    startsAt: instant().notNull(),
  },
  (t) => [
    uniqueIndex("networking_reservations_resource_slot_key").on(
      t.eventId,
      t.resourceKey,
      t.startsAt,
    ),
    index("networking_reservations_meeting_idx").on(t.meetingId),
  ],
);
export const networkingNotifications = pgTable(
  "networking_notifications",
  {
    id: idPk(),
    eventId: eventId(),
    profileId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    type: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    href: text().notNull().default(""),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    readAt: instant(),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    index("networking_notifications_profile_created_idx").on(
      t.profileId,
      t.createdAt,
    ),
  ],
);
export const networkingDeliveries = pgTable(
  "networking_deliveries",
  {
    id: idPk(),
    eventId: eventId(),
    profileId: text().references(() => networkingProfiles.id, {
      onDelete: "cascade",
    }),
    email: text(),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text()
      .$type<"PENDING" | "PROCESSING" | "SENT" | "FAILED" | "SKIPPED">()
      .notNull()
      .default("PENDING"),
    attempts: integer().notNull().default(0),
    availableAt: instant().notNull().defaultNow(),
    lockedUntil: instant(),
    lastError: text(),
    dedupeKey: text().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("networking_deliveries_dedupe_key").on(t.dedupeKey),
    index("networking_deliveries_pending_idx").on(t.status, t.availableAt),
  ],
);
export const networkingPushSubscriptions = pgTable(
  "networking_push_subscriptions",
  {
    id: idPk(),
    eventId: eventId(),
    profileId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    endpoint: text().notNull(),
    keys: jsonb().$type<{ p256dh: string; auth: string }>().notNull(),
    expirationTime: instant(),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [uniqueIndex("networking_push_endpoint_key").on(t.endpoint)],
);
export const networkingAudit = pgTable(
  "networking_audit",
  {
    id: idPk(),
    eventId: eventId(),
    actorId: text().notNull(),
    action: text().notNull(),
    targetId: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    index("networking_audit_event_created_idx").on(t.eventId, t.createdAt),
  ],
);
