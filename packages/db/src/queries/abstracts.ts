import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  ne,
  notInArray,
  or,
  sql,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import {
  UserRole,
  FINAL_STATUSES,
  CODE_SUFFIX,
  type AbstractFinalType,
} from "@app/contracts";
import { createLogger } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { STANDARD_RETRY_DELAYS_MS, standardRetryDelayMs } from "../helpers";
import { DB_NOW, backoffInterval, createLeaseQueue, intervalMs } from "../lease-queue";
import { withTxn, withLockingTxn, withSerializableTxn, pgUniqueViolation } from "../txn";
import { lockAbstractForUpdate, lockAbstractsForUpdate } from "../locks";
import {
  abstractConfig,
  abstractRevisions,
  abstractThemeLinks,
  abstractThemes,
  abstractReviews,
  abstractReviewerThemes,
  abstractCommitteeMemberships,
  abstractCodeCounters,
  abstractBookJobs,
  abstracts,
} from "../schema/abstracts";
import { events } from "../schema/events-access";
import { users } from "../schema/users-clients";
import { registrations } from "../schema/registrations";
import { emailLogs } from "../schema/email";
import { abstractEmailTrigger } from "../schema/enums";
import { auditLogs } from "../schema/outbox-audit";
import { enqueueOutboxEvent, enqueueRealtimeOutboxEvent, insertAuditLog } from "../outbox";

export type AbstractConfigRow = InferSelectModel<typeof abstractConfig>;
export type AbstractThemeRow = InferSelectModel<typeof abstractThemes>;
export type AbstractThemeInsert = InferInsertModel<typeof abstractThemes>;
export type AbstractRow = InferSelectModel<typeof abstracts>;

type ThemeRef = { id: string; label: string };
type ThemeWithSort = { id: string; label: string; sortOrder: number };
type ReviewerRef = { id: string; name: string | null; email: string };
export type AdminReviewRow = InferSelectModel<typeof abstractReviews> & {
  reviewer: ReviewerRef;
};
export type AbstractRevisionRow = InferSelectModel<typeof abstractRevisions>;

/** Admin list/detail row: the abstract plus its themes + (active) reviews. */
export type AdminAbstractRow = AbstractRow & {
  themes: ThemeWithSort[];
  reviews: AdminReviewRow[];
};
export type AdminAbstractDetailRow = AdminAbstractRow & {
  revisions: AbstractRevisionRow[];
};

// ============================================================================
// Audit + outbox helpers
// ============================================================================

export interface AbstractEmailOutboxPayload {
  trigger: string;
  abstractId: string;
  recipientOverride?: { email: string; name?: string };
  extraContext?: Record<string, unknown>;
}

/**
 * Enqueue an abstract-decision/ack email onto the outbox. No maxAttempts
 * override (defaults to 5 — realtime events get 10, abstract emails 5).
 * Rides the caller's transaction via the DbExecutor param.
 */
export async function enqueueAbstractEmailOutboxEvent(
  exec: DbExecutor,
  payload: AbstractEmailOutboxPayload,
  dedupeKey?: string,
): Promise<boolean> {
  return enqueueOutboxEvent(exec, {
    type: "email.abstract",
    payload,
    aggregateType: "Abstract",
    aggregateId: payload.abstractId,
    dedupeKey,
  });
}

export type AbstractEmailTrigger =
  (typeof abstractEmailTrigger.enumValues)[number];

export interface SkippedAbstractEmailRow {
  id: string;
  abstractId: string;
  abstractTrigger: AbstractEmailTrigger;
  recipientEmail: string;
  recipientName: string | null;
  errorMessage: string | null;
  queuedAt: Date;
}

/**
 * Ops query for `requeue-skipped-abstract-emails`: SKIPPED abstract-email rows
 * (abstractId + abstractTrigger non-null), newest first, optionally filtered by
 * event / abstract / trigger. Legacy parity: emailLog.findMany equivalent.
 */
export async function findSkippedAbstractEmails(filter: {
  eventId?: string;
  abstractId?: string;
  trigger?: AbstractEmailTrigger;
  limit: number;
}): Promise<SkippedAbstractEmailRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: emailLogs.id,
      abstractId: emailLogs.abstractId,
      abstractTrigger: emailLogs.abstractTrigger,
      recipientEmail: emailLogs.recipientEmail,
      recipientName: emailLogs.recipientName,
      errorMessage: emailLogs.errorMessage,
      queuedAt: emailLogs.queuedAt,
    })
    .from(emailLogs)
    .where(
      and(
        eq(emailLogs.status, "SKIPPED"),
        isNotNull(emailLogs.abstractId),
        isNotNull(emailLogs.abstractTrigger),
        filter.abstractId
          ? eq(emailLogs.abstractId, filter.abstractId)
          : undefined,
        filter.trigger
          ? eq(emailLogs.abstractTrigger, filter.trigger)
          : undefined,
        filter.eventId
          ? inArray(
              emailLogs.abstractId,
              db
                .select({ id: abstracts.id })
                .from(abstracts)
                .where(eq(abstracts.eventId, filter.eventId)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(emailLogs.queuedAt))
    .limit(filter.limit);

  return rows.flatMap((row): SkippedAbstractEmailRow[] =>
    row.abstractId && row.abstractTrigger
      ? [
          {
            id: row.id,
            abstractId: row.abstractId,
            abstractTrigger: row.abstractTrigger,
            recipientEmail: row.recipientEmail,
            recipientName: row.recipientName,
            errorMessage: row.errorMessage,
            queuedAt: row.queuedAt,
          },
        ]
      : [],
  );
}

// 23505 unique violation on the partial index enforcing one abstract per
// first-author email per event. CockroachDB reports the constraint name in
// `error.constraint`.
function isDuplicateAuthorEmailViolation(error: unknown): boolean {
  const v = pgUniqueViolation(error);
  return (
    v !== null &&
    v.constraint.includes("abstracts_event_id_author_email_normalized_key")
  );
}

// 23505 unique violation on (eventId, code) — two themes sharing a sortOrder
// can allocate the identical code string (H5); catching it here turns an
// opaque 500 into a typed, retryable-by-the-admin failure reason.
function isDuplicateCodeViolation(error: unknown): boolean {
  const v = pgUniqueViolation(error);
  return v !== null && v.constraint.includes("abstracts_event_id_code_key");
}

// ============================================================================
// resolveEvent helper
// ============================================================================

/** Slim event projection for the admin resolveEvent gate. */
export async function findEventClientId(
  eventId: string,
): Promise<{ id: string; clientId: string } | null> {
  const [row] = await getDb()
    .select({ id: events.id, clientId: events.clientId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row ?? null;
}

/** Event name only (committee invite email subject line). */
export async function findEventName(eventId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row?.name ?? null;
}

// ============================================================================
// Config
// ============================================================================

export async function getOrCreateAbstractConfig(
  eventId: string,
): Promise<AbstractConfigRow> {
  const [existing] = await getDb()
    .select()
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, eventId))
    .limit(1);
  if (existing) return existing;

  const [created] = await getDb()
    .insert(abstractConfig)
    .values({ eventId })
    .returning();
  return created;
}

export async function updateAbstractConfig(
  id: string,
  data: Record<string, unknown>,
): Promise<AbstractConfigRow> {
  const [row] = await getDb()
    .update(abstractConfig)
    .set(data)
    .where(eq(abstractConfig.id, id))
    .returning();
  return row;
}

/** Raw information_schema probe: does the abstracts table exist yet (Phase I)? */
export async function abstractsTableExists(): Promise<boolean> {
  const res = await getDb().execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'abstracts'
    ) AS "exists"
  `);
  const rows = (res as { rows?: { exists?: boolean }[] }).rows ?? [];
  return rows[0]?.exists === true;
}

export async function countAbstractsByEvent(eventId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(abstracts)
    .where(eq(abstracts.eventId, eventId));
  return row?.n ?? 0;
}

// ============================================================================
// Themes
// ============================================================================

export async function listThemesByConfigId(
  configId: string,
): Promise<AbstractThemeRow[]> {
  return getDb()
    .select()
    .from(abstractThemes)
    .where(eq(abstractThemes.configId, configId))
    .orderBy(asc(abstractThemes.sortOrder), asc(abstractThemes.label));
}

export async function insertTheme(
  values: AbstractThemeInsert,
): Promise<AbstractThemeRow> {
  const [row] = await getDb().insert(abstractThemes).values(values).returning();
  return row;
}

/** Theme + its config's owning eventId, for the cross-event ownership guard. */
export async function findThemeWithEventId(
  themeId: string,
): Promise<{ theme: AbstractThemeRow; eventId: string } | null> {
  const [row] = await getDb()
    .select({ theme: abstractThemes, eventId: abstractConfig.eventId })
    .from(abstractThemes)
    .innerJoin(abstractConfig, eq(abstractThemes.configId, abstractConfig.id))
    .where(eq(abstractThemes.id, themeId))
    .limit(1);
  return row ?? null;
}

export async function updateThemeRow(
  themeId: string,
  data: Partial<AbstractThemeInsert>,
): Promise<AbstractThemeRow> {
  const [row] = await getDb()
    .update(abstractThemes)
    .set(data)
    .where(eq(abstractThemes.id, themeId))
    .returning();
  return row;
}

export async function softDeleteThemeRow(themeId: string): Promise<void> {
  await getDb()
    .update(abstractThemes)
    .set({ active: false })
    .where(eq(abstractThemes.id, themeId));
}

// ============================================================================
// Public reads
// ============================================================================

export interface PublicConfigData {
  eventId: string;
  eventName: string;
  clientId: string;
  config: AbstractConfigRow | null;
  themes: {
    id: string;
    label: string;
    description: string | null;
    translations: unknown;
  }[];
}

export async function findPublicConfigData(
  slug: string,
): Promise<PublicConfigData | null> {
  const [row] = await getDb()
    .select({ id: events.id, name: events.name, clientId: events.clientId })
    .from(events)
    .where(eq(events.slug, slug))
    .limit(1);
  if (!row) return null;

  const [config] = await getDb()
    .select()
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, row.id))
    .limit(1);

  const themes = config
    ? await getDb()
        .select({
          id: abstractThemes.id,
          label: abstractThemes.label,
          description: abstractThemes.description,
          translations: abstractThemes.translations,
        })
        .from(abstractThemes)
        .where(
          and(
            eq(abstractThemes.configId, config.id),
            eq(abstractThemes.active, true),
          ),
        )
        .orderBy(asc(abstractThemes.sortOrder))
    : [];

  return {
    eventId: row.id,
    eventName: row.name,
    clientId: row.clientId,
    config: config ?? null,
    themes,
  };
}

export interface EventConfigForSubmit {
  event: { id: string; name: string; slug: string; clientId: string };
  config: AbstractConfigRow | null;
}

export async function findEventConfigForSubmit(
  slug: string,
): Promise<EventConfigForSubmit | null> {
  const [row] = await getDb()
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      clientId: events.clientId,
    })
    .from(events)
    .where(eq(events.slug, slug))
    .limit(1);
  if (!row) return null;

  const [config] = await getDb()
    .select()
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, row.id))
    .limit(1);

  return { event: row, config: config ?? null };
}

/** IDs among `ids` that are active themes of the given config. */
export async function findActiveThemeIds(
  ids: string[],
  configId: string,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await getDb()
    .select({ id: abstractThemes.id })
    .from(abstractThemes)
    .where(
      and(
        inArray(abstractThemes.id, ids),
        eq(abstractThemes.configId, configId),
        eq(abstractThemes.active, true),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * The abstract's CURRENT linked themeIds, regardless of theme.active (M14:
 * edit-time re-validation must accept an abstract's own now-deactivated
 * theme, not just the active set findActiveThemeIds filters to).
 */
export async function findAbstractThemeIds(abstractId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ themeId: abstractThemeLinks.themeId })
    .from(abstractThemeLinks)
    .where(eq(abstractThemeLinks.abstractId, abstractId));
  return rows.map((r) => r.themeId);
}

export async function findDuplicateAuthorEmail(
  eventId: string,
  authorEmailNormalized: string,
  excludeAbstractId?: string,
): Promise<boolean> {
  const conds = [
    eq(abstracts.eventId, eventId),
    eq(abstracts.authorEmailNormalized, authorEmailNormalized),
  ];
  if (excludeAbstractId) conds.push(ne(abstracts.id, excludeAbstractId));
  const [row] = await getDb()
    .select({ id: abstracts.id })
    .from(abstracts)
    .where(and(...conds))
    .limit(1);
  return row !== undefined;
}

export interface AbstractForToken extends AbstractRow {
  themes: ThemeRef[];
  config: {
    editingEnabled: boolean;
    editingDeadline: Date | null;
    finalFileUploadEnabled: boolean;
    finalFileDeadline: Date | null;
  } | null;
}

export async function findAbstractForToken(
  id: string,
): Promise<AbstractForToken | null> {
  const [abstract] = await getDb()
    .select()
    .from(abstracts)
    .where(eq(abstracts.id, id))
    .limit(1);
  if (!abstract) return null;

  const themes = await getDb()
    .select({ id: abstractThemes.id, label: abstractThemes.label })
    .from(abstractThemeLinks)
    .innerJoin(abstractThemes, eq(abstractThemeLinks.themeId, abstractThemes.id))
    .where(eq(abstractThemeLinks.abstractId, id));

  const [config] = await getDb()
    .select({
      editingEnabled: abstractConfig.editingEnabled,
      editingDeadline: abstractConfig.editingDeadline,
      finalFileUploadEnabled: abstractConfig.finalFileUploadEnabled,
      finalFileDeadline: abstractConfig.finalFileDeadline,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, abstract.eventId))
    .limit(1);

  return { ...abstract, themes, config: config ?? null };
}

export interface AbstractForEdit extends AbstractRow {
  config: AbstractConfigRow | null;
}

export async function findAbstractForEdit(
  id: string,
): Promise<AbstractForEdit | null> {
  const [abstract] = await getDb()
    .select()
    .from(abstracts)
    .where(eq(abstracts.id, id))
    .limit(1);
  if (!abstract) return null;
  const [config] = await getDb()
    .select()
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, abstract.eventId))
    .limit(1);
  return { ...abstract, config: config ?? null };
}

export interface AbstractForFinalFile extends AbstractRow {
  config: {
    finalFileUploadEnabled: boolean;
    finalFileDeadline: Date | null;
  } | null;
}

/** `forUpdate` row-locks the abstract (inside the caller's transaction). */
export async function findAbstractForFinalFile(
  id: string,
  exec: DbExecutor = getDb(),
  opts: { forUpdate?: boolean } = {},
): Promise<AbstractForFinalFile | null> {
  const query = exec
    .select()
    .from(abstracts)
    .where(eq(abstracts.id, id))
    .limit(1);
  const [abstract] = opts.forUpdate ? await query.for("update") : await query;
  if (!abstract) return null;
  const [config] = await exec
    .select({
      finalFileUploadEnabled: abstractConfig.finalFileUploadEnabled,
      finalFileDeadline: abstractConfig.finalFileDeadline,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, abstract.eventId))
    .limit(1);
  return { ...abstract, config: config ?? null };
}

// ============================================================================
// Admin reads
// ============================================================================

async function loadThemesWithSort(
  abstractIds: string[],
): Promise<Map<string, ThemeWithSort[]>> {
  const map = new Map<string, ThemeWithSort[]>();
  if (abstractIds.length === 0) return map;
  const rows = await getDb()
    .select({
      abstractId: abstractThemeLinks.abstractId,
      id: abstractThemes.id,
      label: abstractThemes.label,
      sortOrder: abstractThemes.sortOrder,
    })
    .from(abstractThemeLinks)
    .innerJoin(abstractThemes, eq(abstractThemeLinks.themeId, abstractThemes.id))
    .where(inArray(abstractThemeLinks.abstractId, abstractIds));
  for (const r of rows) {
    const list = map.get(r.abstractId) ?? [];
    list.push({ id: r.id, label: r.label, sortOrder: r.sortOrder });
    map.set(r.abstractId, list);
  }
  return map;
}

async function loadActiveReviews(
  abstractIds: string[],
): Promise<Map<string, AdminReviewRow[]>> {
  const map = new Map<string, AdminReviewRow[]>();
  if (abstractIds.length === 0) return map;
  const rows = await getDb()
    .select({
      review: abstractReviews,
      reviewer: { id: users.id, name: users.name, email: users.email },
    })
    .from(abstractReviews)
    .innerJoin(users, eq(abstractReviews.reviewerId, users.id))
    .where(
      and(
        inArray(abstractReviews.abstractId, abstractIds),
        eq(abstractReviews.active, true),
      ),
    )
    .orderBy(asc(abstractReviews.createdAt));
  for (const r of rows) {
    const list = map.get(r.review.abstractId) ?? [];
    list.push({ ...r.review, reviewer: r.reviewer });
    map.set(r.review.abstractId, list);
  }
  return map;
}

export interface ListAdminAbstractsFilters {
  presentationType?: AbstractRow["finalType"];
  status?: string;
  themeId?: string;
  reviewerId?: string;
  q?: string;
  limit: number;
  offset: number;
}

export function buildAdminAbstractsWhere(
  eventId: string,
  filters: Omit<ListAdminAbstractsFilters, "limit" | "offset">,
) {
  const conds = [eq(abstracts.eventId, eventId)];
  if (filters.status)
    conds.push(eq(abstracts.status, filters.status as AbstractRow["status"]));
  if (filters.themeId) {
    conds.push(
      inArray(
        abstracts.id,
        getDb()
          .select({ id: abstractThemeLinks.abstractId })
          .from(abstractThemeLinks)
          .where(eq(abstractThemeLinks.themeId, filters.themeId)),
      ),
    );
  }
  if (filters.reviewerId) {
    conds.push(
      inArray(
        abstracts.id,
        getDb()
          .select({ id: abstractReviews.abstractId })
          .from(abstractReviews)
          .where(
            and(
              eq(abstractReviews.reviewerId, filters.reviewerId),
              eq(abstractReviews.active, true),
            ),
          ),
      ),
    );
  }
  const q = filters.q?.trim();
  if (q) {
    const pat = `%${q}%`;
    conds.push(
      sql`(${abstracts.authorFirstName} ILIKE ${pat} OR ${abstracts.authorLastName} ILIKE ${pat} OR ${abstracts.authorAffiliation} ILIKE ${pat} OR ${abstracts.authorEmail} ILIKE ${pat} OR ${abstracts.code} ILIKE ${pat})`,
    );
  }
  if (filters.presentationType) {
    const type = filters.presentationType;
    conds.push(
      type === "CONFERENCE"
        ? eq(abstracts.finalType, type)
        : sql`(${abstracts.finalType} = ${type} OR (${abstracts.finalType} IS NULL AND ${abstracts.requestedType} = ${type}))`,
    );
  }
  return and(...conds);
}

export async function listAdminAbstracts(
  eventId: string,
  filters: ListAdminAbstractsFilters,
): Promise<{ items: AdminAbstractRow[]; total: number }> {
  const where = buildAdminAbstractsWhere(eventId, filters);
  const [rows, totalRows] = await Promise.all([
    getDb()
      .select()
      .from(abstracts)
      .where(where)
      .orderBy(desc(abstracts.createdAt))
      .limit(filters.limit)
      .offset(filters.offset),
    getDb().select({ n: count() }).from(abstracts).where(where),
  ]);

  const ids = rows.map((r) => r.id);
  const [themeMap, reviewMap] = await Promise.all([
    loadThemesWithSort(ids),
    loadActiveReviews(ids),
  ]);

  const items = rows.map((row) => ({
    ...row,
    themes: themeMap.get(row.id) ?? [],
    reviews: reviewMap.get(row.id) ?? [],
  }));
  return { items, total: totalRows[0]?.n ?? 0 };
}

/** Detail read: null when not found OR event mismatch (caller 404s either way). */
export async function getAdminAbstractDetail(
  eventId: string,
  abstractId: string,
): Promise<AdminAbstractDetailRow | null> {
  const [abstract] = await getDb()
    .select()
    .from(abstracts)
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!abstract || abstract.eventId !== eventId) return null;

  const [themeMap, reviewMap, revisions] = await Promise.all([
    loadThemesWithSort([abstractId]),
    loadActiveReviews([abstractId]),
    getDb()
      .select()
      .from(abstractRevisions)
      .where(eq(abstractRevisions.abstractId, abstractId))
      .orderBy(desc(abstractRevisions.revisionNo)),
  ]);

  return {
    ...abstract,
    themes: themeMap.get(abstractId) ?? [],
    reviews: reviewMap.get(abstractId) ?? [],
    revisions,
  };
}

// ============================================================================
// Public writes (transactional — READ COMMITTED, no retry: matches legacy)
// ============================================================================

export interface SubmitAbstractTxnParams {
  id: string;
  eventId: string;
  editToken: string;
  authorFirstName: string;
  authorLastName: string;
  authorAffiliation: string;
  authorEmail: string;
  authorEmailNormalized: string;
  authorPhone: string;
  requestedType: AbstractRow["requestedType"];
  content: unknown;
  coAuthors: unknown;
  additionalFieldsData: unknown;
  linkBaseUrl: string;
  registrationId: string | null;
  themeIds: string[];
  revisionSnapshot: unknown;
  ip?: string;
  submissionAckDedupeKey: string;
}

export async function submitAbstractTxn(
  params: SubmitAbstractTxnParams,
): Promise<{ ok: true; createdAt: Date } | { ok: false; reason: "duplicate_email" }> {
  try {
    return await withTxn(async (tx) => {
      const [created] = await tx
        .insert(abstracts)
        .values({
          id: params.id,
          eventId: params.eventId,
          authorFirstName: params.authorFirstName,
          authorLastName: params.authorLastName,
          authorAffiliation: params.authorAffiliation,
          authorEmail: params.authorEmail,
          authorEmailNormalized: params.authorEmailNormalized,
          authorPhone: params.authorPhone,
          requestedType: params.requestedType,
          content: params.content,
          coAuthors: params.coAuthors,
          additionalFieldsData: params.additionalFieldsData,
          status: "SUBMITTED",
          editToken: params.editToken,
          linkBaseUrl: params.linkBaseUrl,
          registrationId: params.registrationId,
        })
        .returning({ createdAt: abstracts.createdAt });

      await tx.insert(abstractRevisions).values({
        abstractId: params.id,
        revisionNo: 1,
        snapshot: params.revisionSnapshot,
        editedBy: "PUBLIC",
        editedIpAddress: params.ip,
        content: params.content,
        coAuthors: params.coAuthors,
        additionalFieldsData: params.additionalFieldsData,
      });

      if (params.themeIds.length > 0) {
        await tx.insert(abstractThemeLinks).values(
          params.themeIds.map((themeId) => ({
            abstractId: params.id,
            themeId,
          })),
        );
      }

      await insertAuditLog(
        {
          entityType: "Abstract",
          entityId: params.id,
          action: "submit",
          performedBy: "PUBLIC",
          ipAddress: params.ip ?? null,
        },
        tx,
      );

      await enqueueAbstractEmailOutboxEvent(
        tx,
        { trigger: "ABSTRACT_SUBMISSION_ACK", abstractId: params.id },
        params.submissionAckDedupeKey,
      );

      return { ok: true as const, createdAt: created.createdAt };
    });
  } catch (error) {
    if (isDuplicateAuthorEmailViolation(error)) {
      return { ok: false, reason: "duplicate_email" };
    }
    throw error;
  }
}

export interface EditAbstractTxnParams {
  id: string;
  authorFirstName: string;
  authorLastName: string;
  authorAffiliation: string;
  authorEmail: string;
  authorEmailNormalized: string;
  authorPhone: string;
  requestedType: AbstractRow["requestedType"];
  content: unknown;
  coAuthors: unknown;
  additionalFieldsData: unknown;
  registrationId: string | null;
  themeIds: string[];
  revisionSnapshot: unknown;
  lastEditedAt: Date;
  ip?: string;
}

export type EditAbstractResult =
  | { ok: true }
  | { ok: false; reason: "duplicate_email" | "not_editable" };

export async function editAbstractTxn(
  params: EditAbstractTxnParams,
): Promise<EditAbstractResult> {
  try {
    // Serializable + retry: revisionNo is read-max-then-insert, which races
    // under plain READ COMMITTED on abstract_revisions_abstract_id_revision_no_key
    // for concurrent edits of the same abstract (M3).
    return await withSerializableTxn(async (tx): Promise<EditAbstractResult> => {
      const [last] = await tx
        .select({ revisionNo: abstractRevisions.revisionNo })
        .from(abstractRevisions)
        .where(eq(abstractRevisions.abstractId, params.id))
        .orderBy(desc(abstractRevisions.revisionNo))
        .limit(1);
      const nextRevisionNo = (last?.revisionNo ?? 0) + 1;

      // Final-status guard (ADR 0001 rule 5): the caller's status check ran
      // before this transaction, so a decision committed since then must stop
      // the edit here. Nothing is written when no row matches.
      const [edited] = await tx
        .update(abstracts)
        .set({
          authorFirstName: params.authorFirstName,
          authorLastName: params.authorLastName,
          authorAffiliation: params.authorAffiliation,
          authorEmail: params.authorEmail,
          authorEmailNormalized: params.authorEmailNormalized,
          authorPhone: params.authorPhone,
          requestedType: params.requestedType,
          content: params.content,
          coAuthors: params.coAuthors,
          additionalFieldsData: params.additionalFieldsData,
          registrationId: params.registrationId,
          lastEditedAt: params.lastEditedAt,
          contentVersion: sql`${abstracts.contentVersion} + 1`,
        })
        .where(
          and(
            eq(abstracts.id, params.id),
            notInArray(abstracts.status, FINAL_STATUSES),
          ),
        )
        .returning({ id: abstracts.id });
      if (!edited) {
        return { ok: false, reason: "not_editable" };
      }

      await tx.insert(abstractRevisions).values({
        abstractId: params.id,
        revisionNo: nextRevisionNo,
        snapshot: params.revisionSnapshot,
        editedBy: "PUBLIC",
        editedIpAddress: params.ip,
        content: params.content,
        coAuthors: params.coAuthors,
        additionalFieldsData: params.additionalFieldsData,
      });

      await tx
        .delete(abstractThemeLinks)
        .where(eq(abstractThemeLinks.abstractId, params.id));
      if (params.themeIds.length > 0) {
        await tx.insert(abstractThemeLinks).values(
          params.themeIds.map((themeId) => ({
            abstractId: params.id,
            themeId,
          })),
        );
      }

      await insertAuditLog(
        {
          entityType: "Abstract",
          entityId: params.id,
          action: "edit",
          performedBy: "PUBLIC",
          ipAddress: params.ip ?? null,
        },
        tx,
      );

      await enqueueAbstractEmailOutboxEvent(
        tx,
        { trigger: "ABSTRACT_EDIT_ACK", abstractId: params.id },
        `email:abstract:ABSTRACT_EDIT_ACK:${params.id}:${nextRevisionNo}`,
      );

      return { ok: true };
    });
  } catch (error) {
    if (isDuplicateAuthorEmailViolation(error)) {
      return { ok: false, reason: "duplicate_email" };
    }
    throw error;
  }
}

export interface FinalFileUpdate {
  finalFileKey: string;
  finalFileKind: AbstractRow["finalFileKind"];
  finalFileSize: number;
  finalFileUploadedAt: Date;
}

/**
 * Replace an abstract's final file under a row lock. `prepare` re-validates the
 * locked row (throw to abort; nothing is written) and returns the fields and
 * audit row to persist. Resolves with the key the row held before, so the
 * caller can delete that object once this has committed.
 */
export async function updateAbstractFinalFileTxn(
  abstractId: string,
  prepare: (current: AbstractForFinalFile | null) => {
    fields: FinalFileUpdate;
    audit: typeof auditLogs.$inferInsert;
  },
): Promise<{ previousKey: string | null }> {
  return withTxn(async (tx) => {
    const current = await findAbstractForFinalFile(abstractId, tx, {
      forUpdate: true,
    });
    const { fields, audit } = prepare(current);
    await tx
      .update(abstracts)
      .set(fields)
      .where(eq(abstracts.id, abstractId));
    await insertAuditLog(audit, tx);
    return { previousKey: current?.finalFileKey ?? null };
  });
}

// ============================================================================
// Committee — shared row types + access helpers
// ============================================================================

const ONE_HOUR_MS = 60 * 60 * 1000;

export type AbstractMembershipRow = InferSelectModel<
  typeof abstractCommitteeMemberships
>;
export type AbstractReviewRow = InferSelectModel<typeof abstractReviews>;

/** Reviewer-facing abstract row: raw abstract + themes + its ACTIVE reviews. */
export interface ReviewerAbstractRow extends AbstractRow {
  themes: ThemeRef[];
  reviews: AbstractReviewRow[];
}

export async function findAbstractMembership(
  eventId: string,
  userId: string,
): Promise<AbstractMembershipRow | null> {
  const [row] = await getDb()
    .select()
    .from(abstractCommitteeMemberships)
    .where(
      and(
        eq(abstractCommitteeMemberships.userId, userId),
        eq(abstractCommitteeMemberships.eventId, eventId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listActiveReviewerThemeIds(
  eventId: string,
  userId: string,
): Promise<string[]> {
  const rows = await getDb()
    .select({ themeId: abstractReviewerThemes.themeId })
    .from(abstractReviewerThemes)
    .where(
      and(
        eq(abstractReviewerThemes.eventId, eventId),
        eq(abstractReviewerThemes.userId, userId),
        eq(abstractReviewerThemes.active, true),
      ),
    );
  return rows.map((r) => r.themeId);
}

/**
 * Where-clause for the abstracts a reviewer may see: an active explicit review
 * row OR (when they have active theme prefs) a theme overlap. Zero prefs +
 * zero explicit reviews ⇒ nothing.
 */
function accessibleAbstractWhere(
  eventId: string,
  reviewerId: string,
  reviewerThemeIds: string[],
) {
  const orParts = [
    inArray(
      abstracts.id,
      getDb()
        .select({ id: abstractReviews.abstractId })
        .from(abstractReviews)
        .where(
          and(
            eq(abstractReviews.reviewerId, reviewerId),
            eq(abstractReviews.eventId, eventId),
            eq(abstractReviews.active, true),
          ),
        ),
    ),
  ];
  if (reviewerThemeIds.length > 0) {
    orParts.push(
      inArray(
        abstracts.id,
        getDb()
          .select({ id: abstractThemeLinks.abstractId })
          .from(abstractThemeLinks)
          .where(inArray(abstractThemeLinks.themeId, reviewerThemeIds)),
      ),
    );
  }
  return and(eq(abstracts.eventId, eventId), or(...orParts));
}

export async function countAccessibleAbstracts(
  eventId: string,
  reviewerId: string,
): Promise<number> {
  const themeIds = await listActiveReviewerThemeIds(eventId, reviewerId);
  const [row] = await getDb()
    .select({ n: count() })
    .from(abstracts)
    .where(accessibleAbstractWhere(eventId, reviewerId, themeIds));
  return row?.n ?? 0;
}

async function loadThemeRefs(
  abstractIds: string[],
): Promise<Map<string, ThemeRef[]>> {
  const map = new Map<string, ThemeRef[]>();
  if (abstractIds.length === 0) return map;
  const rows = await getDb()
    .select({
      abstractId: abstractThemeLinks.abstractId,
      id: abstractThemes.id,
      label: abstractThemes.label,
    })
    .from(abstractThemeLinks)
    .innerJoin(abstractThemes, eq(abstractThemeLinks.themeId, abstractThemes.id))
    .where(inArray(abstractThemeLinks.abstractId, abstractIds));
  for (const r of rows) {
    const list = map.get(r.abstractId) ?? [];
    list.push({ id: r.id, label: r.label });
    map.set(r.abstractId, list);
  }
  return map;
}

async function loadActiveReviewRows(
  abstractIds: string[],
): Promise<Map<string, AbstractReviewRow[]>> {
  const map = new Map<string, AbstractReviewRow[]>();
  if (abstractIds.length === 0) return map;
  const rows = await getDb()
    .select()
    .from(abstractReviews)
    .where(
      and(
        inArray(abstractReviews.abstractId, abstractIds),
        eq(abstractReviews.active, true),
      ),
    );
  for (const r of rows) {
    const list = map.get(r.abstractId) ?? [];
    list.push(r);
    map.set(r.abstractId, list);
  }
  return map;
}

// ============================================================================
// Committee — member listing + profile
// ============================================================================

export interface CommitteeMemberDto {
  userId: string;
  email: string;
  name: string;
  active: boolean;
  themeIds: string[];
  assignedCount: number;
  scoredCount: number;
}

export async function listCommitteeMembers(
  eventId: string,
): Promise<CommitteeMemberDto[]> {
  const memberships = await getDb()
    .select({
      userId: abstractCommitteeMemberships.userId,
      active: abstractCommitteeMemberships.active,
      email: users.email,
      name: users.name,
    })
    .from(abstractCommitteeMemberships)
    .innerJoin(users, eq(abstractCommitteeMemberships.userId, users.id))
    .where(
      and(
        eq(abstractCommitteeMemberships.eventId, eventId),
        eq(abstractCommitteeMemberships.active, true),
      ),
    )
    .orderBy(asc(abstractCommitteeMemberships.createdAt));

  const userIds = memberships.map((m) => m.userId);

  const [themePrefs, scoredGroups, assignedPairs] = await Promise.all([
    userIds.length
      ? getDb()
          .select({
            userId: abstractReviewerThemes.userId,
            themeId: abstractReviewerThemes.themeId,
          })
          .from(abstractReviewerThemes)
          .where(
            and(
              eq(abstractReviewerThemes.eventId, eventId),
              inArray(abstractReviewerThemes.userId, userIds),
              eq(abstractReviewerThemes.active, true),
            ),
          )
      : Promise.resolve([]),
    userIds.length
      ? getDb()
          .select({
            reviewerId: abstractReviews.reviewerId,
            n: count(),
          })
          .from(abstractReviews)
          .where(
            and(
              eq(abstractReviews.eventId, eventId),
              inArray(abstractReviews.reviewerId, userIds),
              eq(abstractReviews.active, true),
              isNotNull(abstractReviews.scoredAt),
            ),
          )
          .groupBy(abstractReviews.reviewerId)
      : Promise.resolve([]),
    Promise.all(
      memberships.map(
        async (m) =>
          [m.userId, await countAccessibleAbstracts(eventId, m.userId)] as const,
      ),
    ),
  ]);

  const themesByUser = new Map<string, string[]>();
  for (const pref of themePrefs) {
    const current = themesByUser.get(pref.userId) ?? [];
    current.push(pref.themeId);
    themesByUser.set(pref.userId, current);
  }
  const scoredByUser = new Map(scoredGroups.map((g) => [g.reviewerId, g.n]));
  const assignedByUser = new Map(assignedPairs);

  return memberships.map((m) => ({
    userId: m.userId,
    email: m.email,
    name: m.name,
    active: m.active,
    themeIds: themesByUser.get(m.userId) ?? [],
    assignedCount: assignedByUser.get(m.userId) ?? 0,
    scoredCount: scoredByUser.get(m.userId) ?? 0,
  }));
}

export interface CommitteeProfileEvent {
  eventId: string;
  eventName: string;
  assignedCount: number;
  scoredCount: number;
}

export async function getCommitteeProfile(
  userId: string,
): Promise<{ events: CommitteeProfileEvent[] }> {
  const memberships = await getDb()
    .select({
      eventId: abstractCommitteeMemberships.eventId,
      eventName: events.name,
    })
    .from(abstractCommitteeMemberships)
    .innerJoin(events, eq(abstractCommitteeMemberships.eventId, events.id))
    .where(
      and(
        eq(abstractCommitteeMemberships.userId, userId),
        eq(abstractCommitteeMemberships.active, true),
      ),
    )
    .orderBy(asc(abstractCommitteeMemberships.createdAt));

  const eventIds = memberships.map((m) => m.eventId);

  const [assignedPairs, scoredGroups] = await Promise.all([
    Promise.all(
      memberships.map(
        async (m) =>
          [m.eventId, await countAccessibleAbstracts(m.eventId, userId)] as const,
      ),
    ),
    eventIds.length
      ? getDb()
          .select({ eventId: abstractReviews.eventId, n: count() })
          .from(abstractReviews)
          .where(
            and(
              eq(abstractReviews.reviewerId, userId),
              inArray(abstractReviews.eventId, eventIds),
              eq(abstractReviews.active, true),
              isNotNull(abstractReviews.scoredAt),
            ),
          )
          .groupBy(abstractReviews.eventId)
      : Promise.resolve([]),
  ]);

  const assignedByEvent = new Map(assignedPairs);
  const scoredByEvent = new Map(scoredGroups.map((g) => [g.eventId, g.n]));

  return {
    events: memberships.map((m) => ({
      eventId: m.eventId,
      eventName: m.eventName,
      assignedCount: assignedByEvent.get(m.eventId) ?? 0,
      scoredCount: scoredByEvent.get(m.eventId) ?? 0,
    })),
  };
}

// ============================================================================
// Committee — membership mutations
// ============================================================================

export async function upsertCommitteeMembership(
  eventId: string,
  userId: string,
): Promise<void> {
  await getDb()
    .insert(abstractCommitteeMemberships)
    .values({ userId, eventId, active: true })
    .onConflictDoUpdate({
      target: [
        abstractCommitteeMemberships.userId,
        abstractCommitteeMemberships.eventId,
      ],
      set: { active: true },
    });
}

/** Deactivate a membership + all its reviewer-theme prefs in one transaction. */
export async function deactivateCommitteeMembershipTxn(
  eventId: string,
  userId: string,
): Promise<void> {
  await withLockingTxn(async (tx) => {
    await tx
      .update(abstractCommitteeMemberships)
      .set({ active: false })
      .where(
        and(
          eq(abstractCommitteeMemberships.userId, userId),
          eq(abstractCommitteeMemberships.eventId, eventId),
        ),
      );
    await tx
      .update(abstractReviewerThemes)
      .set({ active: false })
      .where(
        and(
          eq(abstractReviewerThemes.eventId, eventId),
          eq(abstractReviewerThemes.userId, userId),
        ),
      );

    // M15: also deactivate this reviewer's active reviews on the event's
    // abstracts, then recompute averageScore/reviewCount/status for each
    // affected abstract — otherwise their score keeps counting and any
    // unscored assignment blocks REVIEW_COMPLETE forever.
    //
    // Finalized abstracts are deliberately untouched: their review rows and
    // stored aggregates are the historical inputs to an already-made decision,
    // and offboarding a member must not rewrite that record.
    //
    // The affected abstracts are locked in ascending id order (ADR 0001) and
    // their status is read after the lock, so a review, assignment or
    // finalize on one of them runs wholly before or after this recompute.
    //
    // The membership UPDATE above holds the membership row, which
    // assignReviewersTxn locks before its abstract (membership → abstracts).
    // An assignment of this member therefore either committed before that
    // UPDATE, and its review is found below, or waits and sees the
    // membership inactive.
    const candidateReviews = await tx
      .select({ abstractId: abstractReviews.abstractId })
      .from(abstractReviews)
      .where(
        and(
          eq(abstractReviews.eventId, eventId),
          eq(abstractReviews.reviewerId, userId),
          eq(abstractReviews.active, true),
        ),
      );
    const lockedIds = await lockAbstractsForUpdate(
      tx,
      candidateReviews.map((r) => r.abstractId),
    );
    if (lockedIds.length === 0) return;
    const openAbstracts = await tx
      .select({ id: abstracts.id })
      .from(abstracts)
      .where(
        and(
          inArray(abstracts.id, lockedIds),
          notInArray(abstracts.status, FINAL_STATUSES),
        ),
      )
      .orderBy(asc(abstracts.id));
    const affectedIds = openAbstracts.map((r) => r.id);
    if (affectedIds.length === 0) return;

    await tx
      .update(abstractReviews)
      .set({ active: false })
      .where(
        and(
          eq(abstractReviews.eventId, eventId),
          eq(abstractReviews.reviewerId, userId),
          eq(abstractReviews.active, true),
          inArray(abstractReviews.abstractId, affectedIds),
        ),
      );
    for (const abstractId of affectedIds) {
      await applyReviewAggregate(tx, abstractId, false);
    }
  });
}

/** Active theme ids for an event's config; null when no config row exists. */
export async function getActiveThemeIdsForEvent(
  eventId: string,
): Promise<string[] | null> {
  const [cfg] = await getDb()
    .select({ id: abstractConfig.id })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, eventId))
    .limit(1);
  if (!cfg) return null;
  const rows = await getDb()
    .select({ id: abstractThemes.id })
    .from(abstractThemes)
    .where(
      and(eq(abstractThemes.configId, cfg.id), eq(abstractThemes.active, true)),
    );
  return rows.map((r) => r.id);
}

/** Replace a reviewer's active theme set: deactivate all, then upsert-active each. */
export async function setReviewerThemesTxn(
  eventId: string,
  userId: string,
  themeIds: string[],
): Promise<void> {
  await withTxn(async (tx) => {
    await tx
      .update(abstractReviewerThemes)
      .set({ active: false })
      .where(
        and(
          eq(abstractReviewerThemes.eventId, eventId),
          eq(abstractReviewerThemes.userId, userId),
        ),
      );
    for (const themeId of themeIds) {
      await tx
        .insert(abstractReviewerThemes)
        .values({ userId, eventId, themeId, active: true })
        .onConflictDoUpdate({
          target: [
            abstractReviewerThemes.userId,
            abstractReviewerThemes.eventId,
            abstractReviewerThemes.themeId,
          ],
          set: { active: true },
        });
    }
  });
}

/**
 * DISTINCT clientIds of every event where the user holds an ACTIVE
 * abstractCommitteeMemberships row. Committee accounts are deliberately
 * global (one reviewer can serve multiple clients' events, see C2), so the
 * set-password guard needs the caller's full cross-tenant membership footprint.
 */
export async function findCommitteeUserClientIds(userId: string): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ clientId: events.clientId })
    .from(abstractCommitteeMemberships)
    .innerJoin(events, eq(abstractCommitteeMemberships.eventId, events.id))
    .where(
      and(
        eq(abstractCommitteeMemberships.userId, userId),
        eq(abstractCommitteeMemberships.active, true),
      ),
    );
  return rows.map((r) => r.clientId);
}

export interface CommitteeInviteTarget {
  active: boolean;
  userEmail: string;
  userName: string;
  eventName: string;
}

export async function findCommitteeInviteTarget(
  eventId: string,
  userId: string,
): Promise<CommitteeInviteTarget | null> {
  const [row] = await getDb()
    .select({
      active: abstractCommitteeMemberships.active,
      userEmail: users.email,
      userName: users.name,
      eventName: events.name,
    })
    .from(abstractCommitteeMemberships)
    .innerJoin(users, eq(abstractCommitteeMemberships.userId, users.id))
    .innerJoin(events, eq(abstractCommitteeMemberships.eventId, events.id))
    .where(
      and(
        eq(abstractCommitteeMemberships.userId, userId),
        eq(abstractCommitteeMemberships.eventId, eventId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ============================================================================
// Committee — reviewer assignment
// ============================================================================

export async function findAbstractBasic(
  abstractId: string,
): Promise<{ id: string; eventId: string; status: AbstractRow["status"] } | null> {
  const [row] = await getDb()
    .select({
      id: abstracts.id,
      eventId: abstracts.eventId,
      status: abstracts.status,
    })
    .from(abstracts)
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  return row ?? null;
}

export async function getCommitteeConfig(
  eventId: string,
): Promise<{ reviewersPerAbstract: number; divergenceThreshold: number } | null> {
  const [row] = await getDb()
    .select({
      reviewersPerAbstract: abstractConfig.reviewersPerAbstract,
      divergenceThreshold: abstractConfig.divergenceThreshold,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, eventId))
    .limit(1);
  return row ?? null;
}

/** Scores of active, scored reviews for an abstract (divergence gate input). */
export async function findScoredReviewScores(
  abstractId: string,
): Promise<number[]> {
  const rows = await getDb()
    .select({ score: abstractReviews.score })
    .from(abstractReviews)
    .where(
      and(
        eq(abstractReviews.abstractId, abstractId),
        eq(abstractReviews.active, true),
        isNotNull(abstractReviews.score),
      ),
    );
  return rows
    .map((r) => r.score)
    .filter((s): s is number => s !== null);
}

export async function findActiveMembershipUserIds(
  eventId: string,
  reviewerIds: string[],
): Promise<string[]> {
  if (reviewerIds.length === 0) return [];
  const rows = await getDb()
    .select({ userId: abstractCommitteeMemberships.userId })
    .from(abstractCommitteeMemberships)
    .where(
      and(
        eq(abstractCommitteeMemberships.eventId, eventId),
        inArray(abstractCommitteeMemberships.userId, reviewerIds),
        eq(abstractCommitteeMemberships.active, true),
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * Lock the event's committee membership rows of these users, in ascending user
 * id order, then return the ids whose membership is active, read after the
 * lock. A bare `SELECT id … FOR UPDATE` (not FOR SHARE: CockroachDB ignores
 * shared locks under SERIALIZABLE by default).
 *
 * Lock order is memberships → abstracts, the order
 * deactivateCommitteeMembershipTxn takes them in (its membership UPDATE, then
 * the abstracts it recomputes). So an assignment and a deactivation of the
 * same member queue: either the deactivation commits first and the
 * assignment sees the membership inactive, or the assignment commits first
 * and the deactivation's later read finds the new review and deactivates it.
 */
async function lockActiveCommitteeMemberIds(
  tx: DbExecutor,
  eventId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  const ordered = [...new Set(userIds)].sort();
  if (ordered.length === 0) return new Set();
  const scope = and(
    eq(abstractCommitteeMemberships.eventId, eventId),
    inArray(abstractCommitteeMemberships.userId, ordered),
  );
  await tx
    .select({ id: abstractCommitteeMemberships.id })
    .from(abstractCommitteeMemberships)
    .where(scope)
    .orderBy(asc(abstractCommitteeMemberships.userId))
    .for("update");
  const active = await tx
    .select({ userId: abstractCommitteeMemberships.userId })
    .from(abstractCommitteeMemberships)
    .where(and(scope, eq(abstractCommitteeMemberships.active, true)));
  return new Set(active.map((row) => row.userId));
}

export type AssignReviewersResult =
  | { ok: true; id: string; status: AbstractRow["status"] }
  | { ok: false; reason: "not_found" | "finalized" }
  | { ok: false; reason: "inactive_member"; reviewerIds: string[] };

/**
 * Replace an abstract's reviewer set and recompute its aggregate.
 *
 * Locks the chosen reviewers' memberships first, then the abstract, and
 * decides from what it reads after the locks: a finalized abstract's
 * reviewers are part of the decision record, so nothing changes; a reviewer
 * whose membership is no longer active is refused, so a member removed at the
 * same moment never ends up holding an active review.
 */
export async function assignReviewersTxn(params: {
  eventId: string;
  abstractId: string;
  reviewerIds: string[];
}): Promise<AssignReviewersResult> {
  const { eventId, abstractId, reviewerIds } = params;
  return withLockingTxn(async (tx): Promise<AssignReviewersResult> => {
    const activeMemberIds = await lockActiveCommitteeMemberIds(tx, eventId, reviewerIds);
    if (!(await lockAbstractForUpdate(tx, abstractId))) {
      return { ok: false, reason: "not_found" };
    }
    const [current] = await tx
      .select({ eventId: abstracts.eventId, status: abstracts.status })
      .from(abstracts)
      .where(eq(abstracts.id, abstractId))
      .limit(1);
    if (!current || current.eventId !== eventId) {
      return { ok: false, reason: "not_found" };
    }
    if (FINAL_STATUSES.includes(current.status)) {
      return { ok: false, reason: "finalized" };
    }
    const inactive = [...new Set(reviewerIds)].filter((id) => !activeMemberIds.has(id));
    if (inactive.length > 0) {
      return { ok: false, reason: "inactive_member", reviewerIds: inactive };
    }

    const inactiveDesired = reviewerIds.length
      ? await tx
          .select({ reviewerId: abstractReviews.reviewerId })
          .from(abstractReviews)
          .where(
            and(
              eq(abstractReviews.abstractId, abstractId),
              inArray(abstractReviews.reviewerId, reviewerIds),
              eq(abstractReviews.active, false),
            ),
          )
      : [];
    const needReset = new Set(inactiveDesired.map((r) => r.reviewerId));

    // Deactivate active reviews for reviewers no longer in the set.
    await tx
      .update(abstractReviews)
      .set({ active: false })
      .where(
        reviewerIds.length
          ? and(
              eq(abstractReviews.abstractId, abstractId),
              eq(abstractReviews.active, true),
              notInArray(abstractReviews.reviewerId, reviewerIds),
            )
          : and(
              eq(abstractReviews.abstractId, abstractId),
              eq(abstractReviews.active, true),
            ),
      );

    for (const reviewerId of reviewerIds) {
      const resetPrior = needReset.has(reviewerId);
      await tx
        .insert(abstractReviews)
        .values({ abstractId, eventId, reviewerId, active: true })
        .onConflictDoUpdate({
          target: [abstractReviews.abstractId, abstractReviews.reviewerId],
          set: resetPrior
            ? {
                eventId,
                active: true,
                score: null,
                comment: null,
                scoredAt: null,
              }
            : { eventId, active: true },
        });
    }

    // H8/M16: recompute averageScore/reviewCount/status from the surviving
    // active reviews instead of carrying the old status through untouched —
    // removed reviewers' scores must stop counting, and a stale
    // REVIEW_COMPLETE must not survive a newly added unscored reviewer.
    const updated = await applyReviewAggregate(tx, abstractId, reviewerIds.length > 0);
    return { ok: true, ...updated };
  });
}

// ============================================================================
// Committee — reviewer reads (anonymized in the service layer)
// ============================================================================

export async function listAssignedAbstracts(
  eventId: string,
  reviewerId: string,
): Promise<ReviewerAbstractRow[]> {
  const themeIds = await listActiveReviewerThemeIds(eventId, reviewerId);
  const rows = await getDb()
    .select()
    .from(abstracts)
    .where(accessibleAbstractWhere(eventId, reviewerId, themeIds))
    .orderBy(asc(abstracts.createdAt));
  const ids = rows.map((r) => r.id);
  const [themeMap, reviewMap] = await Promise.all([
    loadThemeRefs(ids),
    loadActiveReviewRows(ids),
  ]);
  return rows.map((r) => ({
    ...r,
    themes: themeMap.get(r.id) ?? [],
    reviews: reviewMap.get(r.id) ?? [],
  }));
}

export async function getAssignedAbstractRow(
  abstractId: string,
): Promise<ReviewerAbstractRow | null> {
  const [abstract] = await getDb()
    .select()
    .from(abstracts)
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!abstract) return null;
  const [themeMap, reviewMap] = await Promise.all([
    loadThemeRefs([abstractId]),
    loadActiveReviewRows([abstractId]),
  ]);
  return {
    ...abstract,
    themes: themeMap.get(abstractId) ?? [],
    reviews: reviewMap.get(abstractId) ?? [],
  };
}

export interface AbstractForReview {
  id: string;
  eventId: string;
  status: AbstractRow["status"];
  clientId: string;
  config: {
    scoringStartAt: Date | null;
    scoringDeadline: Date | null;
    divergenceThreshold: number;
    commentsEnabled: boolean;
  } | null;
  themes: ThemeRef[];
  reviews: { reviewerId: string; active: boolean }[];
}

export async function findAbstractForReview(
  abstractId: string,
): Promise<AbstractForReview | null> {
  const [row] = await getDb()
    .select({
      id: abstracts.id,
      eventId: abstracts.eventId,
      status: abstracts.status,
      clientId: events.clientId,
    })
    .from(abstracts)
    .innerJoin(events, eq(abstracts.eventId, events.id))
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!row) return null;

  const [cfg] = await getDb()
    .select({
      scoringStartAt: abstractConfig.scoringStartAt,
      scoringDeadline: abstractConfig.scoringDeadline,
      divergenceThreshold: abstractConfig.divergenceThreshold,
      commentsEnabled: abstractConfig.commentsEnabled,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, row.eventId))
    .limit(1);

  const [themeMap, reviews] = await Promise.all([
    loadThemeRefs([abstractId]),
    getDb()
      .select({
        reviewerId: abstractReviews.reviewerId,
        active: abstractReviews.active,
      })
      .from(abstractReviews)
      .where(
        and(
          eq(abstractReviews.abstractId, abstractId),
          eq(abstractReviews.active, true),
        ),
      ),
  ]);

  return {
    ...row,
    config: cfg ?? null,
    themes: themeMap.get(abstractId) ?? [],
    reviews,
  };
}

// ============================================================================
// Committee — review submission (score aggregation + divergence)
// ============================================================================

async function notifyScoreDivergence(input: {
  db: DbExecutor;
  abstractId: string;
  eventId: string;
  clientId: string;
  averageScore: number | null;
  reviewCount: number;
  scores: number[];
  threshold: number;
}): Promise<void> {
  if (input.scores.length < 2) return;
  const min = Math.min(...input.scores);
  const max = Math.max(...input.scores);
  if (max - min <= 0 || max - min < input.threshold) return;

  const since = new Date(Date.now() - ONE_HOUR_MS);
  const [existing] = await input.db
    .select({ id: emailLogs.id })
    .from(emailLogs)
    .where(
      and(
        eq(emailLogs.abstractId, input.abstractId),
        eq(emailLogs.abstractTrigger, "ABSTRACT_SCORE_DIVERGENCE"),
        gte(emailLogs.queuedAt, since),
      ),
    )
    .limit(1);
  if (existing) return;

  const admins = await input.db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(
      and(
        eq(users.clientId, input.clientId),
        eq(users.role, UserRole.CLIENT_ADMIN),
        eq(users.active, true),
      ),
    );

  const dedupeBucket = Math.floor(Date.now() / ONE_HOUR_MS);
  // One statement at a time: these ride the caller's transaction, whose single
  // connection cannot run statements concurrently.
  for (const admin of admins) {
    await enqueueAbstractEmailOutboxEvent(
      input.db,
      {
        trigger: "ABSTRACT_SCORE_DIVERGENCE",
        abstractId: input.abstractId,
        recipientOverride: { email: admin.email, name: admin.name },
        extraContext: {
          averageScore: input.averageScore,
          reviewCount: input.reviewCount,
          minScore: min,
          maxScore: max,
          divergenceThreshold: input.threshold,
        },
      },
      `email:abstract:ABSTRACT_SCORE_DIVERGENCE:${input.abstractId}:${admin.email}:${dedupeBucket}`,
    );
  }

  await enqueueRealtimeOutboxEvent(input.db, {
    type: "abstract.scoreDiverged",
    clientId: input.clientId,
    eventId: input.eventId,
    payload: {
      id: input.abstractId,
      averageScore: input.averageScore,
      reviewCount: input.reviewCount,
      minScore: min,
      maxScore: max,
      divergenceThreshold: input.threshold,
    },
    ts: Date.now(),
  });
}

/**
 * Aggregate an abstract's remaining ACTIVE reviews into averageScore/
 * reviewCount/allScored. Shared by reviewAbstractTxn, assignReviewersTxn
 * (H8/M16), and deactivateCommitteeMembershipTxn (M15) so a reviewer-set
 * change never leaves stale aggregates behind.
 */
async function computeReviewAggregate(
  tx: DbExecutor,
  abstractId: string,
): Promise<{
  averageScore: number | null;
  reviewCount: number;
  allScored: boolean;
  scores: number[];
}> {
  const assignments = await tx
    .select({ scoredAt: abstractReviews.scoredAt, score: abstractReviews.score })
    .from(abstractReviews)
    .where(
      and(eq(abstractReviews.abstractId, abstractId), eq(abstractReviews.active, true)),
    );
  const scores = assignments
    .map((r) => r.score)
    .filter((s): s is number => s !== null);
  const reviewCount = assignments.filter((r) => r.scoredAt !== null).length;
  const averageScore = scores.length
    ? scores.reduce((sum, s) => sum + s, 0) / scores.length
    : null;
  const allScored =
    assignments.length > 0 && assignments.every((r) => r.scoredAt !== null);
  return { averageScore, reviewCount, allScored, scores };
}

/**
 * Derive the post-recompute status. Never overrides a terminal decision
 * (FINAL_STATUSES); otherwise preserves the SUBMITTED->UNDER_REVIEW
 * transition on first assignment (`hasReviewers`), advances to
 * REVIEW_COMPLETE once every active review is scored, and — the M16 fix —
 * falls a stale REVIEW_COMPLETE back to UNDER_REVIEW the moment that stops
 * being true (e.g. a post-divergence extra reviewer was just added unscored).
 */
function deriveReviewStatus(
  currentStatus: AbstractRow["status"],
  hasReviewers: boolean,
  allScored: boolean,
): AbstractRow["status"] {
  if (FINAL_STATUSES.includes(currentStatus)) return currentStatus;
  const base =
    hasReviewers && currentStatus === "SUBMITTED" ? "UNDER_REVIEW" : currentStatus;
  if (allScored) return "REVIEW_COMPLETE";
  return base === "REVIEW_COMPLETE" ? "UNDER_REVIEW" : base;
}

/**
 * Recompute + write averageScore/reviewCount/status for one abstract. The
 * caller holds the abstract's row lock; the status is read here, after it.
 * No-op on finalized abstracts: the stored aggregate is part of the decision
 * record and must never be rewritten after the fact (deriveReviewStatus
 * already refuses to move a terminal status; this extends the same rule to
 * the score fields).
 */
async function applyReviewAggregate(
  tx: DbExecutor,
  abstractId: string,
  hasReviewers: boolean,
): Promise<{ id: string; status: AbstractRow["status"] }> {
  const [current] = await tx
    .select({ status: abstracts.status })
    .from(abstracts)
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!current) throw lockedAbstractChanged(abstractId);
  if (FINAL_STATUSES.includes(current.status)) {
    return { id: abstractId, status: current.status };
  }
  const { averageScore, reviewCount, allScored } = await computeReviewAggregate(
    tx,
    abstractId,
  );
  const status = deriveReviewStatus(current.status, hasReviewers, allScored);
  const [updated] = await tx
    .update(abstracts)
    .set({ averageScore, reviewCount, status })
    .where(
      and(
        eq(abstracts.id, abstractId),
        notInArray(abstracts.status, FINAL_STATUSES),
      ),
    )
    .returning({ id: abstracts.id, status: abstracts.status });
  if (!updated) throw lockedAbstractChanged(abstractId);
  return updated;
}

/**
 * A row the caller locked changed under the lock. Unreachable while callers
 * lock first; thrown (not returned) so the transaction rolls back.
 */
function lockedAbstractChanged(abstractId: string): Error {
  return new Error(`Abstract ${abstractId} changed while its row lock was held`);
}

export type ReviewAbstractResult =
  | {
      ok: true;
      id: string;
      status: AbstractRow["status"];
      averageScore: number | null;
      reviewCount: number;
    }
  | { ok: false; reason: "not_found" | "finalized" | "not_assigned" };

export async function reviewAbstractTxn(params: {
  abstractId: string;
  eventId: string;
  reviewerId: string;
  clientId: string;
  score: number;
  comment: string | null | undefined;
  commentsEnabled: boolean;
  divergenceThreshold: number;
}): Promise<ReviewAbstractResult> {
  const {
    abstractId,
    eventId,
    reviewerId,
    clientId,
    score,
    commentsEnabled,
    divergenceThreshold,
  } = params;
  const commentValue = commentsEnabled === false ? null : (params.comment ?? null);

  // Lock first, then re-read (ADR 0001): parallel reviews of one abstract
  // queue on its row, so each recompute sees every committed score, and a
  // decision committed before the lock is seen here.
  return withLockingTxn(async (tx): Promise<ReviewAbstractResult> => {
    if (!(await lockAbstractForUpdate(tx, abstractId))) {
      return { ok: false, reason: "not_found" };
    }
    const [current] = await tx
      .select({ status: abstracts.status })
      .from(abstracts)
      .where(eq(abstracts.id, abstractId))
      .limit(1);
    if (!current) return { ok: false, reason: "not_found" };
    if (FINAL_STATUSES.includes(current.status)) {
      return { ok: false, reason: "finalized" };
    }

    // Only an active assignment can be scored: a reviewer removed since the
    // caller's check matches no row, and nothing is written.
    const [review] = await tx
      .update(abstractReviews)
      .set({ score, comment: commentValue, scoredAt: new Date() })
      .where(
        and(
          eq(abstractReviews.abstractId, abstractId),
          eq(abstractReviews.reviewerId, reviewerId),
          eq(abstractReviews.active, true),
        ),
      )
      .returning({ id: abstractReviews.id });
    if (!review) return { ok: false, reason: "not_assigned" };

    const { averageScore, reviewCount, allScored, scores } =
      await computeReviewAggregate(tx, abstractId);
    const status = deriveReviewStatus(current.status, true, allScored);

    const [updated] = await tx
      .update(abstracts)
      .set({ averageScore, reviewCount, status })
      .where(
        and(
          eq(abstracts.id, abstractId),
          notInArray(abstracts.status, FINAL_STATUSES),
        ),
      )
      .returning({
        id: abstracts.id,
        status: abstracts.status,
        averageScore: abstracts.averageScore,
        reviewCount: abstracts.reviewCount,
      });
    if (!updated) throw lockedAbstractChanged(abstractId);

    await insertAuditLog(
      {
        entityType: "AbstractReview",
        entityId: abstractId,
        action: "score",
        changes: { score: { old: null, new: score } },
        performedBy: reviewerId,
      },
      tx,
    );

    if (updated.status === "REVIEW_COMPLETE") {
      await enqueueRealtimeOutboxEvent(tx, {
        type: "abstract.reviewCompleted",
        clientId,
        eventId,
        payload: {
          id: updated.id,
          status: updated.status,
          averageScore: updated.averageScore,
          reviewCount: updated.reviewCount,
        },
        ts: Date.now(),
      });
    }

    await notifyScoreDivergence({
      db: tx,
      abstractId,
      eventId,
      clientId,
      averageScore: updated.averageScore,
      reviewCount: updated.reviewCount,
      scores,
      threshold: divergenceThreshold,
    });

    return { ok: true, ...updated };
  });
}

// ============================================================================
// Admin decisions — finalize / reopen / presented
// ============================================================================

function collectCommitteeComments(
  reviews: { name: string | null; comment: string | null }[],
): string {
  return reviews
    .map((review, index) => {
      const comment = review.comment?.trim();
      if (!comment) return null;
      const label = review.name?.trim() || `Reviewer ${index + 1}`;
      return `${label}: ${comment}`;
    })
    .filter((c): c is string => Boolean(c))
    .join("\n\n");
}

async function allocateAbstractCode(
  tx: DbExecutor,
  eventId: string,
  finalType: AbstractFinalType,
  theme: { id: string; sortOrder: number },
): Promise<{ code: string; codeNumber: number }> {
  const [seedAbs] = await tx
    .select({ m: max(abstracts.codeNumber) })
    .from(abstracts)
    .innerJoin(abstractThemeLinks, eq(abstractThemeLinks.abstractId, abstracts.id))
    .where(
      and(
        eq(abstracts.eventId, eventId),
        eq(abstracts.finalType, finalType),
        isNotNull(abstracts.codeNumber),
        eq(abstractThemeLinks.themeId, theme.id),
      ),
    );
  const [seedCounter] = await tx
    .select({ lastValue: abstractCodeCounters.lastValue })
    .from(abstractCodeCounters)
    .where(
      and(
        eq(abstractCodeCounters.eventId, eventId),
        eq(abstractCodeCounters.themeId, theme.id),
        eq(abstractCodeCounters.finalType, finalType),
      ),
    )
    .limit(1);
  const seedValue = Math.max(seedAbs?.m ?? 0, seedCounter?.lastValue ?? 0);

  const [counter] = await tx
    .insert(abstractCodeCounters)
    .values({ eventId, themeId: theme.id, finalType, lastValue: seedValue + 1 })
    .onConflictDoUpdate({
      target: [
        abstractCodeCounters.eventId,
        abstractCodeCounters.themeId,
        abstractCodeCounters.finalType,
      ],
      set: { lastValue: sql`${abstractCodeCounters.lastValue} + 1` },
    })
    .returning({ lastValue: abstractCodeCounters.lastValue });

  const codeNumber = counter.lastValue;
  const code = `${CODE_SUFFIX[finalType]}${theme.sortOrder}-${String(codeNumber).padStart(2, "0")}`;
  return { code, codeNumber };
}

export type FinalizeResult =
  | {
      ok: false;
      reason:
        | "not_found"
        | "already_finalized"
        | "missing_final_type"
        | "no_theme"
        | "code_conflict";
    }
  | { ok: true };

export async function finalizeAbstractTxn(params: {
  eventId: string;
  abstractId: string;
  decision: AbstractRow["status"];
  finalType: AbstractFinalType | undefined;
  performedBy: string;
}): Promise<FinalizeResult> {
  const { eventId, abstractId, decision, finalType, performedBy } = params;
  try {
    // Lock first, then re-read (ADR 0001): a review or assignment in flight
    // commits before this reads the reviews and decides, and any that start
    // later see the final status after their own lock.
    return await withLockingTxn(async (tx): Promise<FinalizeResult> => {
      if (!(await lockAbstractForUpdate(tx, abstractId))) {
        return { ok: false, reason: "not_found" };
      }
      const [existing] = await tx
        .select()
        .from(abstracts)
        .where(eq(abstracts.id, abstractId))
        .limit(1);
      if (!existing || existing.eventId !== eventId) {
        return { ok: false, reason: "not_found" };
      }
      if (FINAL_STATUSES.includes(existing.status)) {
        return { ok: false, reason: "already_finalized" };
      }
      if (decision === "ACCEPTED" && !finalType) {
        return { ok: false, reason: "missing_final_type" };
      }

      const [ev] = await tx
        .select({ clientId: events.clientId })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      const [cfg] = await tx
        .select({
          commentsEnabled: abstractConfig.commentsEnabled,
          commentsSentToAuthor: abstractConfig.commentsSentToAuthor,
          finalFileUploadEnabled: abstractConfig.finalFileUploadEnabled,
        })
        .from(abstractConfig)
        .where(eq(abstractConfig.eventId, eventId))
        .limit(1);
      const reviews = await tx
        .select({ comment: abstractReviews.comment, name: users.name })
        .from(abstractReviews)
        .innerJoin(users, eq(abstractReviews.reviewerId, users.id))
        .where(
          and(
            eq(abstractReviews.abstractId, abstractId),
            eq(abstractReviews.active, true),
          ),
        )
        .orderBy(asc(abstractReviews.createdAt));
      const themes = await tx
        .select({ id: abstractThemes.id, sortOrder: abstractThemes.sortOrder })
        .from(abstractThemeLinks)
        .innerJoin(abstractThemes, eq(abstractThemeLinks.themeId, abstractThemes.id))
        .where(eq(abstractThemeLinks.abstractId, abstractId))
        .orderBy(asc(abstractThemes.sortOrder));

      const nextData: {
        status: AbstractRow["status"];
        finalType: AbstractFinalType | null;
        code?: string | null;
        codeNumber?: number | null;
      } = {
        status: decision,
        finalType: decision === "ACCEPTED" ? (finalType as AbstractFinalType) : null,
      };

      let allocatedCode: { code: string; codeNumber: number } | null = null;
      if (decision === "ACCEPTED") {
        const codeTheme = themes[0];
        if (!codeTheme) {
          return { ok: false, reason: "no_theme" };
        }
        if (existing.codeNumber != null) {
          const code = `${CODE_SUFFIX[finalType as AbstractFinalType]}${codeTheme.sortOrder}-${String(existing.codeNumber).padStart(2, "0")}`;
          allocatedCode = { code, codeNumber: existing.codeNumber };
        } else {
          allocatedCode = await allocateAbstractCode(
            tx,
            eventId,
            finalType as AbstractFinalType,
            codeTheme,
          );
        }
        nextData.code = allocatedCode.code;
        nextData.codeNumber = allocatedCode.codeNumber;
      } else {
        nextData.code = null;
        nextData.codeNumber = null;
      }

      // Final-status guard (ADR 0001 rule 5); the row lock already rules out
      // another finalize in between, so 0 rows means it was final before.
      const [updated] = await tx
        .update(abstracts)
        .set(nextData)
        .where(
          and(
            eq(abstracts.id, abstractId),
            notInArray(abstracts.status, FINAL_STATUSES),
          ),
        )
        .returning({
          id: abstracts.id,
          status: abstracts.status,
          code: abstracts.code,
          averageScore: abstracts.averageScore,
          reviewCount: abstracts.reviewCount,
        });
      if (!updated) {
        return { ok: false, reason: "already_finalized" };
      }

      await insertAuditLog(
        {
          entityType: "Abstract",
          entityId: abstractId,
          action: "finalize",
          changes: {
            status: { old: existing.status, new: decision },
            finalType: { old: existing.finalType, new: finalType ?? null },
            code: { old: existing.code, new: allocatedCode?.code ?? null },
          },
          performedBy,
        },
        tx,
      );

      const decisionTrigger =
        updated.status === "ACCEPTED"
          ? "ABSTRACT_ACCEPTED"
          : updated.status === "REJECTED"
            ? "ABSTRACT_REJECTED"
            : "ABSTRACT_DECISION";
      const decisionDedupeSuffix = `${abstractId}:${existing.updatedAt.getTime()}`;

      await enqueueAbstractEmailOutboxEvent(
        tx,
        { trigger: decisionTrigger, abstractId },
        `email:abstract:${decisionTrigger}:${decisionDedupeSuffix}`,
      );

      if (cfg?.commentsEnabled && cfg.commentsSentToAuthor) {
        const committeeComments = collectCommitteeComments(reviews);
        if (committeeComments) {
          await enqueueAbstractEmailOutboxEvent(
            tx,
            {
              trigger: "ABSTRACT_COMMITTEE_COMMENTS",
              abstractId,
              extraContext: { committeeComments },
            },
            `email:abstract:ABSTRACT_COMMITTEE_COMMENTS:${decisionDedupeSuffix}`,
          );
        }
      }

      if (updated.status === "ACCEPTED" && cfg?.finalFileUploadEnabled) {
        await enqueueAbstractEmailOutboxEvent(
          tx,
          { trigger: "ABSTRACT_FINAL_FILE_REQUEST", abstractId },
          `email:abstract:ABSTRACT_FINAL_FILE_REQUEST:${decisionDedupeSuffix}`,
        );
      }

      await enqueueRealtimeOutboxEvent(tx, {
        type: "abstract.finalized",
        clientId: ev?.clientId ?? "",
        eventId,
        payload: {
          id: updated.id,
          status: updated.status,
          code: updated.code,
          averageScore: updated.averageScore,
          reviewCount: updated.reviewCount,
        },
        ts: Date.now(),
      });

      return { ok: true };
    });
  } catch (error) {
    // H5: two themes sharing a sortOrder (or a codeNumber race) can allocate
    // an identical code string, violating abstracts_event_id_code_key. Map it
    // to a typed reason instead of letting the raw 23505 escape as a 500.
    if (isDuplicateCodeViolation(error)) {
      return { ok: false, reason: "code_conflict" };
    }
    throw error;
  }
}

export type ReopenResult =
  | { ok: false; reason: "not_found" | "not_finalized" }
  | { ok: true };

export async function reopenAbstractTxn(params: {
  eventId: string;
  abstractId: string;
  performedBy: string;
}): Promise<ReopenResult> {
  const { eventId, abstractId, performedBy } = params;
  return withLockingTxn(async (tx): Promise<ReopenResult> => {
    if (!(await lockAbstractForUpdate(tx, abstractId))) {
      return { ok: false, reason: "not_found" };
    }
    const [existing] = await tx
      .select()
      .from(abstracts)
      .where(eq(abstracts.id, abstractId))
      .limit(1);
    if (!existing || existing.eventId !== eventId) {
      return { ok: false, reason: "not_found" };
    }
    if (!FINAL_STATUSES.includes(existing.status)) {
      return { ok: false, reason: "not_finalized" };
    }

    const [ev] = await tx
      .select({ clientId: events.clientId })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    const [{ n: activeReviewCount }] = await tx
      .select({ n: count() })
      .from(abstractReviews)
      .where(
        and(
          eq(abstractReviews.abstractId, abstractId),
          eq(abstractReviews.active, true),
        ),
      );
    const nextStatus =
      activeReviewCount > 0 ? ("UNDER_REVIEW" as const) : ("SUBMITTED" as const);

    const [updated] = await tx
      .update(abstracts)
      .set({
        status: nextStatus,
        finalType: null,
        code: null,
        codeNumber: null,
        // M6: clear stale presented flags from a prior decision cycle so a
        // reopened, re-decided abstract isn't still certificate-eligible.
        presentedAt: null,
        presentedBy: null,
      })
      .where(eq(abstracts.id, abstractId))
      .returning({
        id: abstracts.id,
        status: abstracts.status,
        averageScore: abstracts.averageScore,
        reviewCount: abstracts.reviewCount,
      });

    await insertAuditLog(
      {
        entityType: "Abstract",
        entityId: abstractId,
        action: "reopen",
        changes: {
          status: { old: existing.status, new: nextStatus },
          finalType: { old: existing.finalType, new: null },
          code: { old: existing.code, new: null },
          codeNumber: { old: existing.codeNumber, new: null },
        },
        performedBy,
      },
      tx,
    );

    await enqueueRealtimeOutboxEvent(tx, {
      type: "abstract.reopened",
      clientId: ev?.clientId ?? "",
      eventId,
      payload: {
        id: updated.id,
        status: updated.status,
        averageScore: updated.averageScore,
        reviewCount: updated.reviewCount,
      },
      ts: Date.now(),
    });

    return { ok: true };
  });
}

export type PresentedResult =
  | { ok: false; reason: "not_found" | "not_accepted" }
  | { ok: true };

export async function markAbstractPresentedTxn(params: {
  eventId: string;
  abstractId: string;
  presented: boolean;
  performedBy: string;
}): Promise<PresentedResult> {
  const { eventId, abstractId, presented, performedBy } = params;
  const [existing] = await getDb()
    .select({
      id: abstracts.id,
      eventId: abstracts.eventId,
      status: abstracts.status,
      presentedAt: abstracts.presentedAt,
      clientId: events.clientId,
    })
    .from(abstracts)
    .innerJoin(events, eq(abstracts.eventId, events.id))
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!existing || existing.eventId !== eventId) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "ACCEPTED") {
    return { ok: false, reason: "not_accepted" };
  }

  return withTxn(async (tx): Promise<PresentedResult> => {
    const updated = await tx
      .update(abstracts)
      .set(
        presented
          ? { presentedAt: new Date(), presentedBy: performedBy }
          : { presentedAt: null, presentedBy: null },
      )
      .where(
        and(
          eq(abstracts.id, abstractId),
          eq(abstracts.eventId, eventId),
          eq(abstracts.status, "ACCEPTED"),
        ),
      )
      .returning({ id: abstracts.id });
    if (updated.length === 0) {
      return { ok: false, reason: "not_accepted" };
    }

    await insertAuditLog(
      {
        entityType: "Abstract",
        entityId: abstractId,
        action: presented ? "mark_presented" : "unmark_presented",
        changes: {
          presentedAt: {
            old: existing.presentedAt,
            new: presented ? "now" : null,
          },
        },
        performedBy,
      },
      tx,
    );

    await enqueueRealtimeOutboxEvent(tx, {
      type: "abstract.presentationChanged",
      clientId: existing.clientId,
      eventId,
      payload: { id: abstractId, presented },
      ts: Date.now(),
    });

    return { ok: true };
  });
}

// ============================================================================
// Abstract Book jobs — a lease queue (packages/db/src/lease-queue).
//
// The worker owns PDF generation and runs each job through runLeased: the
// claim uses FOR UPDATE SKIP LOCKED, a heartbeat renews the lease while the
// render runs (a lost lease aborts it), and every terminal write re-checks
// ownership (status=RUNNING AND locked_by=workerId) so a worker that lost its
// lease can't clobber another's result. Lease times come from the database
// clock; the worker's LeaseRecoveryJob recovers expired leases.
// ============================================================================

const bookLogger = createLogger({ name: "db:abstract-book" });

export type AbstractBookJobRow = InferSelectModel<typeof abstractBookJobs>;

/**
 * Worker lease (5 min). The heartbeat renews it every third of that while a
 * render runs, so a dead worker's job is recovered within minutes instead of
 * an hour.
 */
export const ABSTRACT_BOOK_LEASE_MS = 5 * 60 * 1000;

/**
 * abstract_book_jobs as a lease queue. Due PENDING jobs under max_attempts are
 * claimable (FIFO); RUNNING is the lease. A released job goes back to PENDING,
 * due now. An expired lease is requeued PENDING with the retry backoff, or
 * dead-lettered to FAILED once its attempts are used up.
 */
export const abstractBookQueue = createLeaseQueue({
  name: "abstract-book",
  table: "abstract_book_jobs",
  leasedStatus: "RUNNING",
  leaseMs: ABSTRACT_BOOK_LEASE_MS,
  claimable: sql`"status" = 'PENDING'
    AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${DB_NOW})
    AND "attempt_count" < "max_attempts"`,
  order: sql`"created_at" ASC`,
  claimSet: sql`"started_at" = COALESCE("started_at", ${DB_NOW}), "error_message" = NULL`,
  releaseSet: sql`"status" = 'PENDING', "next_attempt_at" = NULL`,
  recovery: {
    exhausted: sql`"attempt_count" >= "max_attempts"`,
    retrySet: sql`"status" = 'PENDING',
      "next_attempt_at" = ${DB_NOW} + ${backoffInterval(sql`"attempt_count"`, STANDARD_RETRY_DELAYS_MS)},
      "error_message" = COALESCE("error_message", 'Abstract Book job lease expired; requeued for retry')`,
    deadSet: sql`"status" = 'FAILED', "completed_at" = ${DB_NOW}, "next_attempt_at" = NULL,
      "error_message" = COALESCE("error_message", 'Abstract Book job lease expired and retry limit was exhausted')`,
  },
});

export type EnqueueBookJobResult =
  | { ok: false; reason: "no_config" }
  | { ok: false; reason: "unfinished"; unfinishedCount: number }
  | { ok: true; job: AbstractBookJobRow };

const ACTIVE_BOOK_JOB_STATUSES = ["PENDING", "RUNNING"] as const;

// 23505 unique violation on the partial index enforcing one active (PENDING/
// RUNNING) book job per event (L1).
function isDuplicateActiveBookJobViolation(error: unknown): boolean {
  const v = pgUniqueViolation(error);
  return v !== null && v.constraint.includes("abstract_book_jobs_event_id_active_key");
}

async function findActiveAbstractBookJob(
  db: DbExecutor,
  eventId: string,
): Promise<AbstractBookJobRow | null> {
  const [existing] = await db
    .select()
    .from(abstractBookJobs)
    .where(
      and(
        eq(abstractBookJobs.eventId, eventId),
        inArray(abstractBookJobs.status, ACTIVE_BOOK_JOB_STATUSES),
      ),
    )
    .limit(1);
  return existing ?? null;
}

/**
 * Enqueue a PENDING book job. Gated: the AbstractConfig must exist, and there
 * must be zero abstracts still outside FINAL_STATUSES. Create + audit ride one
 * READ COMMITTED transaction. An expired RUNNING job of the event is
 * recovered first (3.4), so a dead worker never blocks a new request.
 *
 * L1: idempotent against duplicates — if a PENDING/RUNNING job already covers
 * this event, that job is returned as-is (ok:true, no new insert) instead of
 * enqueueing a second one; the partial unique index backstops the remaining
 * check-then-insert race with the same idempotent response.
 */
export async function enqueueAbstractBookJob(params: {
  eventId: string;
  requestedBy: string;
}): Promise<EnqueueBookJobResult> {
  const { eventId, requestedBy } = params;
  const db = getDb();
  const [cfgRows, unfinishedRows] = await Promise.all([
    db
      .select({ id: abstractConfig.id })
      .from(abstractConfig)
      .where(eq(abstractConfig.eventId, eventId))
      .limit(1),
    db
      .select({ n: count() })
      .from(abstracts)
      .where(
        and(
          eq(abstracts.eventId, eventId),
          notInArray(abstracts.status, FINAL_STATUSES),
        ),
      ),
  ]);
  if (!cfgRows[0]) return { ok: false, reason: "no_config" };
  const unfinishedCount = unfinishedRows[0]?.n ?? 0;
  if (unfinishedCount > 0) {
    return { ok: false, reason: "unfinished", unfinishedCount };
  }

  // A RUNNING job whose worker died would otherwise block this event until
  // the worker's lease recovery runs: recover it now (requeued, or FAILED
  // once its attempts are used up, which lets a new job start).
  const recovered = await abstractBookQueue.recoverStale(sql`"event_id" = ${eventId}`);
  if (recovered.requeued > 0 || recovered.deadLettered > 0) {
    bookLogger.warn({ eventId, ...recovered }, "Recovered an expired Abstract Book job lease on enqueue");
  }

  try {
    return await withTxn(async (tx): Promise<EnqueueBookJobResult> => {
      const existing = await findActiveAbstractBookJob(tx, eventId);
      if (existing) return { ok: true, job: existing };

      const [job] = await tx
        .insert(abstractBookJobs)
        .values({ eventId, requestedBy, status: "PENDING" })
        .returning();
      await insertAuditLog(
        {
          entityType: "AbstractBookJob",
          entityId: job.id,
          action: "enqueue",
          changes: { status: { old: null, new: "PENDING" } },
          performedBy: requestedBy,
        },
        tx,
      );
      return { ok: true, job };
    });
  } catch (error) {
    if (isDuplicateActiveBookJobViolation(error)) {
      const existing = await findActiveAbstractBookJob(db, eventId);
      if (existing) return { ok: true, job: existing };
    }
    throw error;
  }
}

/** Last 20 jobs for an event, newest first. */
export async function listAbstractBookJobs(
  eventId: string,
): Promise<AbstractBookJobRow[]> {
  return getDb()
    .select()
    .from(abstractBookJobs)
    .where(eq(abstractBookJobs.eventId, eventId))
    .orderBy(desc(abstractBookJobs.createdAt))
    .limit(20);
}

/** Single job scoped to its event; null if missing or the event mismatches. */
export async function getAbstractBookJob(
  eventId: string,
  jobId: string,
): Promise<AbstractBookJobRow | null> {
  const [job] = await getDb()
    .select()
    .from(abstractBookJobs)
    .where(eq(abstractBookJobs.id, jobId))
    .limit(1);
  if (!job || job.eventId !== eventId) return null;
  return job;
}

/**
 * The claimed jobs still leased to `workerId`, oldest first (claim ids come
 * unordered; a row taken over since the claim is left out).
 */
export async function loadClaimedAbstractBookJobs(
  ids: string[],
  workerId: string,
): Promise<AbstractBookJobRow[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select()
    .from(abstractBookJobs)
    .where(
      and(
        inArray(abstractBookJobs.id, ids),
        eq(abstractBookJobs.status, "RUNNING"),
        eq(abstractBookJobs.lockedBy, workerId),
      ),
    )
    .orderBy(asc(abstractBookJobs.createdAt));
}

/** Mark COMPLETED and clear the lease, while `workerId` owns the job. False when the lease was lost. */
export async function completeAbstractBookJob(params: {
  jobId: string;
  workerId: string;
  storageKey: string;
  includedCount: number;
}): Promise<boolean> {
  return abstractBookQueue.complete(
    params.workerId,
    params.jobId,
    sql`"status" = 'COMPLETED', "storage_key" = ${params.storageKey},
      "included_count" = ${params.includedCount}, "completed_at" = ${DB_NOW},
      "error_message" = NULL, "next_attempt_at" = NULL`,
  );
}

/**
 * Fail a job: back to PENDING with backoff while attempts remain, else
 * dead-letter to FAILED. Only while `workerId` owns it; false when the lease
 * was lost. `attemptCount` includes the failed attempt.
 */
export async function failAbstractBookJob(params: {
  jobId: string;
  workerId: string;
  attemptCount: number;
  maxAttempts: number;
  message: string;
}): Promise<boolean> {
  const set =
    params.attemptCount < params.maxAttempts
      ? sql`"status" = 'PENDING', "error_message" = ${params.message}, "completed_at" = NULL,
          "next_attempt_at" = ${DB_NOW} + ${intervalMs(standardRetryDelayMs(params.attemptCount))}`
      : sql`"status" = 'FAILED', "error_message" = ${params.message}, "completed_at" = ${DB_NOW},
          "next_attempt_at" = NULL`;
  return abstractBookQueue.fail(params.workerId, params.jobId, set);
}

// ----------------------------------------------------------------------------
// Abstract Book queue health (ops /health/abstract-book-jobs)
// ----------------------------------------------------------------------------

const ABSTRACT_BOOK_PENDING_UNHEALTHY_SIZE = 100;
const ABSTRACT_BOOK_PENDING_UNHEALTHY_AGE_MS = 60 * 60 * 1000; // 1h

export interface AbstractBookQueueHealth {
  pendingCount: number;
  duePendingCount: number;
  runningCount: number;
  staleRunningCount: number;
  failedCount: number;
  oldestPendingAgeMs: number;
  isHealthy: boolean;
}

export async function getAbstractBookQueueHealth(): Promise<AbstractBookQueueHealth> {
  const now = new Date();
  const db = getDb();
  const countWhere = async (where: SQL): Promise<number> => {
    const [row] = await db
      .select({ n: count() })
      .from(abstractBookJobs)
      .where(where);
    return row?.n ?? 0;
  };

  const [
    pendingCount,
    duePendingCount,
    runningCount,
    staleRunningCount,
    failedCount,
    oldestPending,
  ] = await Promise.all([
    countWhere(eq(abstractBookJobs.status, "PENDING")),
    countWhere(
      and(
        eq(abstractBookJobs.status, "PENDING"),
        or(
          isNull(abstractBookJobs.nextAttemptAt),
          lte(abstractBookJobs.nextAttemptAt, now),
        ),
      )!,
    ),
    countWhere(eq(abstractBookJobs.status, "RUNNING")),
    countWhere(
      and(
        eq(abstractBookJobs.status, "RUNNING"),
        or(
          isNull(abstractBookJobs.lockedUntil),
          lt(abstractBookJobs.lockedUntil, now),
        ),
      )!,
    ),
    countWhere(eq(abstractBookJobs.status, "FAILED")),
    // Age computed in SQL (now() - MIN(col)) — never JS-parse a naive timestamp
    // read from the DB, which skews by the host offset on non-UTC hosts.
    // Mirrors getOutboxHealth. MIN over an empty set → NULL → 0.
    db
      .select({
        age: sql<number>`coalesce(extract(epoch from (now() - min(${abstractBookJobs.createdAt}))) * 1000, 0)::float8`,
      })
      .from(abstractBookJobs)
      .where(eq(abstractBookJobs.status, "PENDING")),
  ]);

  const oldestPendingAgeMs = Math.round(Number(oldestPending[0]?.age ?? 0));

  const isHealthy =
    staleRunningCount === 0 &&
    pendingCount < ABSTRACT_BOOK_PENDING_UNHEALTHY_SIZE &&
    oldestPendingAgeMs < ABSTRACT_BOOK_PENDING_UNHEALTHY_AGE_MS;

  return {
    pendingCount,
    duePendingCount,
    runningCount,
    staleRunningCount,
    failedCount,
    oldestPendingAgeMs,
    isHealthy,
  };
}

// ----------------------------------------------------------------------------
// Abstract Book PDF data (worker book job renders the PDF from this snapshot).
// Mirrors the legacy generateAbstractBookPdf fetch: event name + book config +
// every ACCEPTED abstract with its themes. null → event missing; config null →
// caller throws "Abstract configuration not found" (legacy 404 semantics).
// ----------------------------------------------------------------------------

export interface AbstractBookConfig {
  bookFontFamily: string;
  bookFontSize: number;
  bookLineSpacing: number;
  bookOrder: AbstractConfigRow["bookOrder"];
  bookIncludeAuthorNames: boolean;
  // H9: additive — lets the book renderer print each additional-field's
  // (e.g. keywords) value alongside content sections, per its schema label.
  additionalFieldsSchema: AbstractConfigRow["additionalFieldsSchema"];
}

export interface AbstractBookData {
  eventName: string;
  config: AbstractBookConfig;
  abstracts: (AbstractRow & { themes: ThemeWithSort[] })[];
}

export async function getAbstractBookData(
  eventId: string,
): Promise<AbstractBookData | null> {
  const db = getDb();
  const [ev] = await db
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!ev) return null;

  const [cfg] = await db
    .select({
      bookFontFamily: abstractConfig.bookFontFamily,
      bookFontSize: abstractConfig.bookFontSize,
      bookLineSpacing: abstractConfig.bookLineSpacing,
      bookOrder: abstractConfig.bookOrder,
      bookIncludeAuthorNames: abstractConfig.bookIncludeAuthorNames,
      additionalFieldsSchema: abstractConfig.additionalFieldsSchema,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, eventId))
    .limit(1);
  if (!cfg) return null;

  const rows = await db
    .select()
    .from(abstracts)
    .where(and(eq(abstracts.eventId, eventId), eq(abstracts.status, "ACCEPTED")))
    .orderBy(asc(abstracts.codeNumber));

  const themeMap = await loadThemesWithSort(rows.map((r) => r.id));
  return {
    eventName: ev.name,
    config: cfg,
    abstracts: rows.map((r) => ({ ...r, themes: themeMap.get(r.id) ?? [] })),
  };
}

// ----------------------------------------------------------------------------
// Abstract email context (worker email.abstract handler → queueAbstractEmail).
// Ports the legacy prisma fetch: abstract + its event (name/slug/clientId) +
// the abstract config deadline fields. Config may be absent (dates default to
// null / finalFileUploadEnabled false), matching legacy `config?.x ?? …`.
// ----------------------------------------------------------------------------

export interface AbstractForEmailContext {
  id: string;
  authorFirstName: string;
  authorLastName: string;
  authorEmail: string;
  content: AbstractRow["content"];
  status: string;
  requestedType: string;
  finalType: string | null;
  code: string | null;
  editToken: string;
  linkBaseUrl: string | null;
  eventId: string;
  event: { name: string; slug: string; clientId: string };
  config: {
    submissionStartAt: Date | null;
    submissionDeadline: Date | null;
    editingDeadline: Date | null;
    scoringStartAt: Date | null;
    scoringDeadline: Date | null;
    finalFileDeadline: Date | null;
    finalFileUploadEnabled: boolean;
  };
}

export async function getAbstractForEmailContext(
  abstractId: string,
): Promise<AbstractForEmailContext | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: abstracts.id,
      authorFirstName: abstracts.authorFirstName,
      authorLastName: abstracts.authorLastName,
      authorEmail: abstracts.authorEmail,
      content: abstracts.content,
      status: abstracts.status,
      requestedType: abstracts.requestedType,
      finalType: abstracts.finalType,
      code: abstracts.code,
      editToken: abstracts.editToken,
      linkBaseUrl: abstracts.linkBaseUrl,
      eventId: abstracts.eventId,
      eventName: events.name,
      eventSlug: events.slug,
      eventClientId: events.clientId,
    })
    .from(abstracts)
    .innerJoin(events, eq(abstracts.eventId, events.id))
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!row) return null;

  const [cfg] = await db
    .select({
      submissionStartAt: abstractConfig.submissionStartAt,
      submissionDeadline: abstractConfig.submissionDeadline,
      editingDeadline: abstractConfig.editingDeadline,
      scoringStartAt: abstractConfig.scoringStartAt,
      scoringDeadline: abstractConfig.scoringDeadline,
      finalFileDeadline: abstractConfig.finalFileDeadline,
      finalFileUploadEnabled: abstractConfig.finalFileUploadEnabled,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, row.eventId))
    .limit(1);

  return {
    id: row.id,
    authorFirstName: row.authorFirstName,
    authorLastName: row.authorLastName,
    authorEmail: row.authorEmail,
    content: row.content,
    status: row.status,
    requestedType: row.requestedType,
    finalType: row.finalType,
    code: row.code,
    editToken: row.editToken,
    linkBaseUrl: row.linkBaseUrl,
    eventId: row.eventId,
    event: { name: row.eventName, slug: row.eventSlug, clientId: row.eventClientId },
    config: {
      submissionStartAt: cfg?.submissionStartAt ?? null,
      submissionDeadline: cfg?.submissionDeadline ?? null,
      editingDeadline: cfg?.editingDeadline ?? null,
      scoringStartAt: cfg?.scoringStartAt ?? null,
      scoringDeadline: cfg?.scoringDeadline ?? null,
      finalFileDeadline: cfg?.finalFileDeadline ?? null,
      finalFileUploadEnabled: cfg?.finalFileUploadEnabled ?? false,
    },
  };
}

// ============================================================================
// registrationId validation (M4)
// ============================================================================

/** The eventId a registration belongs to, or null if it doesn't exist. */
export async function findRegistrationEventId(
  registrationId: string,
): Promise<string | null> {
  const [row] = await getDb()
    .select({ eventId: registrations.eventId })
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);
  return row?.eventId ?? null;
}

// ============================================================================
// L3: reviewer assignment config needs distributeByTheme too
// ============================================================================

/**
 * Same shape as getCommitteeConfig plus distributeByTheme (L3: the flag was
 * defined on the schema but read nowhere in the assignReviewers path, so
 * assignments never enforced theme overlap even when admins turned it on).
 * Appended rather than added as a field to getCommitteeConfig to avoid
 * touching that existing export.
 */
export async function getReviewerAssignmentConfig(
  eventId: string,
): Promise<{
  reviewersPerAbstract: number;
  divergenceThreshold: number;
  distributeByTheme: boolean;
} | null> {
  const [row] = await getDb()
    .select({
      reviewersPerAbstract: abstractConfig.reviewersPerAbstract,
      divergenceThreshold: abstractConfig.divergenceThreshold,
      distributeByTheme: abstractConfig.distributeByTheme,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, eventId))
    .limit(1);
  return row ?? null;
}

// ============================================================================
// H5: theme sortOrder guards — codes embed the live sortOrder, so a theme
// that already has printed (coded) abstracts can't have its sortOrder moved
// without splitting/colliding the printed series.
// ============================================================================

/** Count of abstracts linked to this theme that already have a printed code. */
export async function countCodedAbstractsByTheme(themeId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(abstractThemeLinks)
    .innerJoin(abstracts, eq(abstracts.id, abstractThemeLinks.abstractId))
    .where(
      and(eq(abstractThemeLinks.themeId, themeId), isNotNull(abstracts.code)),
    );
  return row?.n ?? 0;
}

/** Same filters as the admin list, without pagination. */
export async function findAbstractsForExport(
  eventId: string,
  filters: Omit<ListAdminAbstractsFilters, "limit" | "offset">,
): Promise<AdminAbstractRow[]> {
  const rows = await getDb()
    .select()
    .from(abstracts)
    .where(buildAdminAbstractsWhere(eventId, filters))
    .orderBy(asc(abstracts.code), desc(abstracts.createdAt));
  const ids = rows.map((r) => r.id);
  const [themes, reviews] = await Promise.all([
    loadThemesWithSort(ids),
    loadActiveReviews(ids),
  ]);
  return rows.map((row) => ({
    ...row,
    themes: themes.get(row.id) ?? [],
    reviews: reviews.get(row.id) ?? [],
  }));
}
