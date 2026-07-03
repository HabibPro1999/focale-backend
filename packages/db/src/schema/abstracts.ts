import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idPk, timestamps } from "../helpers";
import {
  abstractBookJobStatus,
  abstractBookOrder,
  abstractFileKind,
  abstractFinalType,
  abstractRequestedType,
  abstractStatus,
  abstractSubmissionMode,
} from "./enums";
import { events } from "./events-access";
import { registrations } from "./registrations";
import { users } from "./users-clients";

export const abstractConfig = pgTable(
  "abstract_config",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    submissionMode: abstractSubmissionMode().notNull().default("FREE_TEXT"),
    globalWordLimit: integer().default(500),
    sectionWordLimits: jsonb(),
    submissionStartAt: timestamp({ precision: 3 }),
    submissionDeadline: timestamp({ precision: 3 }),
    editingDeadline: timestamp({ precision: 3 }),
    scoringStartAt: timestamp({ precision: 3 }),
    scoringDeadline: timestamp({ precision: 3 }),
    finalFileDeadline: timestamp({ precision: 3 }),
    editingEnabled: boolean().notNull().default(false),
    commentsEnabled: boolean().notNull().default(false),
    commentsSentToAuthor: boolean().notNull().default(false),
    finalFileUploadEnabled: boolean().notNull().default(false),
    reviewersPerAbstract: integer().notNull().default(2),
    divergenceThreshold: integer().notNull().default(6),
    maxThemesPerAbstract: integer(),
    distributeByTheme: boolean().notNull().default(false),
    modeLocked: boolean().notNull().default(false),
    bookFontFamily: text().notNull().default("Arial"),
    bookFontSize: integer().notNull().default(11),
    bookLineSpacing: doublePrecision().notNull().default(1.5),
    bookOrder: abstractBookOrder().notNull().default("BY_CODE"),
    bookIncludeAuthorNames: boolean().notNull().default(true),
    additionalFieldsSchema: jsonb().notNull().default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex("abstract_config_event_id_key").on(t.eventId)],
);

export const abstractThemes = pgTable(
  "abstract_themes",
  {
    id: idPk(),
    configId: text()
      .notNull()
      .references(() => abstractConfig.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    label: text().notNull(),
    description: text(),
    sortOrder: integer().notNull().default(0),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [index("abstract_themes_config_id_active_idx").on(t.configId, t.active)],
);

export const abstractCodeCounters = pgTable(
  "abstract_code_counters",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    themeId: text()
      .notNull()
      .references(() => abstractThemes.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    finalType: abstractFinalType().notNull(),
    lastValue: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("abstract_code_counters_theme_id_idx").on(t.themeId),
    uniqueIndex("abstract_code_counters_event_id_theme_id_final_type_key").on(
      t.eventId,
      t.themeId,
      t.finalType,
    ),
  ],
);

export const abstractCodeSequences = pgTable(
  "abstract_code_sequences",
  {
    id: idPk(),
    finalType: abstractFinalType().notNull(),
    lastValue: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("abstract_code_sequences_final_type_key").on(t.finalType)],
);

export const abstractBookJobs = pgTable(
  "abstract_book_jobs",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    requestedBy: text().notNull(),
    status: abstractBookJobStatus().notNull().default("PENDING"),
    storageKey: text(),
    errorMessage: text(),
    includedCount: integer().notNull().default(0),
    attemptCount: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(3),
    lastAttemptAt: timestamp({ precision: 3 }),
    nextAttemptAt: timestamp({ precision: 3 }),
    lockedAt: timestamp({ precision: 3 }),
    lockedUntil: timestamp({ precision: 3 }),
    lockedBy: text(),
    createdAt: timestamp({ precision: 3 }).defaultNow().notNull(),
    startedAt: timestamp({ precision: 3 }),
    completedAt: timestamp({ precision: 3 }),
    // App-managed (Prisma @updatedAt): no DB default, matches live column.
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("abstract_book_jobs_event_id_created_at_idx").on(
      t.eventId,
      t.createdAt.desc(),
    ),
    index("abstract_book_jobs_status_created_at_idx").on(t.status, t.createdAt),
    index("abstract_book_jobs_status_next_attempt_at_created_at_idx").on(
      t.status,
      t.nextAttemptAt,
      t.createdAt,
    ),
    index("abstract_book_jobs_status_locked_until_idx").on(t.status, t.lockedUntil),
    index("abstract_book_jobs_locked_by_idx").on(t.lockedBy),
  ],
);

export const abstracts = pgTable(
  "abstracts",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    authorFirstName: text().notNull(),
    authorLastName: text().notNull(),
    authorAffiliation: text(),
    authorEmail: text().notNull(),
    authorEmailNormalized: text(),
    authorPhone: text().notNull(),
    requestedType: abstractRequestedType().notNull(),
    content: jsonb().notNull(),
    coAuthors: jsonb().notNull().default([]),
    additionalFieldsData: jsonb().notNull().default({}),
    code: text(),
    codeNumber: integer(),
    status: abstractStatus().notNull().default("SUBMITTED"),
    contentVersion: integer().notNull().default(1),
    finalType: abstractFinalType(),
    averageScore: doublePrecision(),
    reviewCount: integer().notNull().default(0),
    presentedAt: timestamp({ precision: 3 }),
    presentedBy: text(),
    finalFileKey: text(),
    finalFileKind: abstractFileKind(),
    finalFileSize: integer(),
    finalFileUploadedAt: timestamp({ precision: 3 }),
    editToken: text().notNull(),
    lastEditedAt: timestamp({ precision: 3 }),
    linkBaseUrl: text(),
    registrationId: text().references(() => registrations.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("abstracts_edit_token_key").on(t.editToken),
    index("abstracts_event_id_status_idx").on(t.eventId, t.status),
    index("abstracts_event_id_created_at_idx").on(t.eventId, t.createdAt.desc()),
    index("abstracts_author_email_idx").on(t.authorEmail),
    index("abstracts_event_id_author_email_normalized_idx").on(
      t.eventId,
      t.authorEmailNormalized,
    ),
    index("abstracts_registration_id_idx").on(t.registrationId),
    uniqueIndex("abstracts_event_id_code_key").on(t.eventId, t.code),
  ],
);

export const abstractCommitteeMemberships = pgTable(
  "abstract_committee_memberships",
  {
    id: idPk(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("abstract_committee_memberships_event_id_active_idx").on(
      t.eventId,
      t.active,
    ),
    index("abstract_committee_memberships_user_id_active_idx").on(t.userId, t.active),
    uniqueIndex("abstract_committee_memberships_user_id_event_id_key").on(
      t.userId,
      t.eventId,
    ),
  ],
);

export const abstractReviews = pgTable(
  "abstract_reviews",
  {
    id: idPk(),
    abstractId: text()
      .notNull()
      .references(() => abstracts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    reviewerId: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    score: doublePrecision(),
    comment: text(),
    scoredAt: timestamp({ precision: 3 }),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("abstract_reviews_reviewer_id_event_id_active_scored_at_idx").on(
      t.reviewerId,
      t.eventId,
      t.active,
      t.scoredAt,
    ),
    index("abstract_reviews_event_id_active_scored_at_idx").on(
      t.eventId,
      t.active,
      t.scoredAt,
    ),
    index("abstract_reviews_abstract_id_active_idx").on(t.abstractId, t.active),
    uniqueIndex("abstract_reviews_abstract_id_reviewer_id_key").on(
      t.abstractId,
      t.reviewerId,
    ),
  ],
);

export const abstractReviewerThemes = pgTable(
  "abstract_reviewer_themes",
  {
    id: idPk(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    themeId: text()
      .notNull()
      .references(() => abstractThemes.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("abstract_reviewer_themes_event_id_theme_id_idx").on(t.eventId, t.themeId),
    index("abstract_reviewer_themes_user_id_event_id_active_idx").on(
      t.userId,
      t.eventId,
      t.active,
    ),
    uniqueIndex("abstract_reviewer_themes_user_id_event_id_theme_id_key").on(
      t.userId,
      t.eventId,
      t.themeId,
    ),
  ],
);

export const abstractRevisions = pgTable(
  "abstract_revisions",
  {
    id: idPk(),
    abstractId: text()
      .notNull()
      .references(() => abstracts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    revisionNo: integer().notNull(),
    snapshot: jsonb().notNull(),
    editedBy: text().notNull(),
    editedIpAddress: text(),
    content: jsonb().notNull(),
    coAuthors: jsonb().notNull().default([]),
    additionalFieldsData: jsonb().notNull().default({}),
    createdAt: timestamp({ precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("abstract_revisions_abstract_id_revision_no_key").on(
      t.abstractId,
      t.revisionNo,
    ),
  ],
);

export const abstractThemeLinks = pgTable(
  "abstract_theme_links",
  {
    id: idPk(),
    abstractId: text()
      .notNull()
      .references(() => abstracts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    themeId: text()
      .notNull()
      .references(() => abstractThemes.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (t) => [
    index("abstract_theme_links_theme_id_idx").on(t.themeId),
    uniqueIndex("abstract_theme_links_abstract_id_theme_id_key").on(
      t.abstractId,
      t.themeId,
    ),
  ],
);
