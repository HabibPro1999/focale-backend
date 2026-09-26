/** Admin abstract reads: the filtered list, the detail and the export pages. */
import { and, asc, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { getDb, type DbExecutor } from "../../client";
import { pagesByIds, type ExportPageOptions } from "../export-pages";
import {
  abstractReviews,
  abstractRevisions,
  abstractThemeLinks,
  abstracts,
} from "../../schema/abstracts";
import { users } from "../../schema/users-clients";
import {
  loadActiveReviews,
  loadThemesWithSort,
  type AbstractRow,
  type AdminAbstractDetailRow,
  type AdminAbstractRow,
} from "./shared";

// ============================================================================
// Admin reads
// ============================================================================

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
// Export
// ============================================================================

/** What the abstracts export needs before its first row. */
export interface AbstractsExportPlan {
  /** Filtered abstract ids in export order (code, then newest first). */
  ids: string[];
  /** Most active reviews on one of them: the number of reviewer columns. */
  maxReviews: number;
}

/**
 * The admin list's filters, without pagination: the matching ids in export
 * order and the reviewer-column count. Rows are then read by
 * iterateAbstractsForExport, EXPORT_PAGE_SIZE at a time. Ids rather than a
 * keyset: `code` is nullable and PostgreSQL and CockroachDB place NULLs at
 * opposite ends of an ascending sort, so the engine's own order is kept.
 */
export async function getAbstractsExportPlan(
  eventId: string,
  filters: Omit<ListAdminAbstractsFilters, "limit" | "offset">,
  db: DbExecutor = getDb(),
): Promise<AbstractsExportPlan> {
  const where = buildAdminAbstractsWhere(eventId, filters);
  const rows = await db
    .select({ id: abstracts.id })
    .from(abstracts)
    .where(where)
    .orderBy(asc(abstracts.code), desc(abstracts.createdAt), asc(abstracts.id));
  if (rows.length === 0) return { ids: [], maxReviews: 0 };
  // Counted like loadActiveReviews reads them (active, reviewer joined).
  const perAbstract = db
    .select({ n: count().as("n") })
    .from(abstractReviews)
    .innerJoin(users, eq(abstractReviews.reviewerId, users.id))
    .where(
      and(
        eq(abstractReviews.active, true),
        inArray(
          abstractReviews.abstractId,
          db.select({ id: abstracts.id }).from(abstracts).where(where),
        ),
      ),
    )
    .groupBy(abstractReviews.abstractId)
    .as("per_abstract");
  const [top] = await db.select({ maxReviews: max(perAbstract.n) }).from(perAbstract);
  return { ids: rows.map((row) => row.id), maxReviews: Number(top?.maxReviews ?? 0) };
}

/** Export rows (themes and active reviews included) for `ids`, in that order. */
export function iterateAbstractsForExport(
  ids: readonly string[],
  options: ExportPageOptions = {},
): AsyncGenerator<AdminAbstractRow[]> {
  return pagesByIds(
    ids,
    options,
    async (chunk, tx) => {
      const rows = await tx.select().from(abstracts).where(inArray(abstracts.id, chunk));
      const [themes, reviews] = [
        await loadThemesWithSort(chunk, tx),
        await loadActiveReviews(chunk, tx),
      ];
      return rows.map((row) => ({
        ...row,
        themes: themes.get(row.id) ?? [],
        reviews: reviews.get(row.id) ?? [],
      }));
    },
    (row) => row.id,
  );
}
