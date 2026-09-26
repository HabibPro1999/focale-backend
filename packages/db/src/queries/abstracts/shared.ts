/**
 * Abstracts queries: row types, event lookups and the outbox helper shared by
 * every abstracts module, plus the row loaders the list/detail/book/export
 * reads use. The loaders are exported for the sibling modules only; the
 * `../abstracts` barrel does not re-export them.
 */
import {
  and,
  asc,
  eq,
  inArray,
  type InferInsertModel,
  type InferSelectModel,
} from "drizzle-orm";
import { getDb, type DbExecutor } from "../../client";
import { enqueueOutboxEvent } from "../../outbox";
import {
  abstractCommitteeMemberships,
  abstractConfig,
  abstractReviews,
  abstractRevisions,
  abstractThemeLinks,
  abstractThemes,
  abstracts,
} from "../../schema/abstracts";
import { events } from "../../schema/events-access";
import { users } from "../../schema/users-clients";

export type AbstractConfigRow = InferSelectModel<typeof abstractConfig>;
export type AbstractThemeRow = InferSelectModel<typeof abstractThemes>;
export type AbstractThemeInsert = InferInsertModel<typeof abstractThemes>;
export type AbstractRow = InferSelectModel<typeof abstracts>;

export type ThemeRef = { id: string; label: string };
export type ThemeWithSort = { id: string; label: string; sortOrder: number };
export type ReviewerRef = { id: string; name: string | null; email: string };
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

export type AbstractMembershipRow = InferSelectModel<
  typeof abstractCommitteeMemberships
>;
export type AbstractReviewRow = InferSelectModel<typeof abstractReviews>;

/** Reviewer-facing abstract row: raw abstract + themes + its ACTIVE reviews. */
export interface ReviewerAbstractRow extends AbstractRow {
  themes: ThemeRef[];
  reviews: AbstractReviewRow[];
}

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
// Row loaders (module-internal)
// ============================================================================

export async function loadThemesWithSort(
  abstractIds: string[],
  db: DbExecutor = getDb(),
): Promise<Map<string, ThemeWithSort[]>> {
  const map = new Map<string, ThemeWithSort[]>();
  if (abstractIds.length === 0) return map;
  const rows = await db
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

export async function loadActiveReviews(
  abstractIds: string[],
  db: DbExecutor = getDb(),
): Promise<Map<string, AdminReviewRow[]>> {
  const map = new Map<string, AdminReviewRow[]>();
  if (abstractIds.length === 0) return map;
  const rows = await db
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

export async function loadThemeRefs(
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

export async function loadActiveReviewRows(
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
