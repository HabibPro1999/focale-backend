/** Abstract themes: CRUD and the printed-code guard on sortOrder moves. */
import { and, asc, count, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { withLockingTxn, withSerializableTxn } from "../../txn";
import { getDb } from "../../client";
import {
  abstractConfig,
  abstractReviewerThemes,
  abstractCodeCounters,
  abstractThemeLinks,
  abstractThemes,
  abstracts,
} from "../../schema/abstracts";
import type { AbstractThemeInsert, AbstractThemeRow } from "./shared";

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

/** Refuse every reference instead of letting cascading FKs erase theme history. */
export function deleteUnusedAbstractTheme(eventId: string, themeId: string) {
  return withLockingTxn(async (tx) => {
    const [owned] = await tx.select({ id: abstractThemes.id }).from(abstractThemes)
      .innerJoin(abstractConfig, eq(abstractConfig.id, abstractThemes.configId))
      .where(and(eq(abstractThemes.id, themeId), eq(abstractConfig.eventId, eventId))).for("update");
    if (!owned) return "NOT_FOUND" as const;
    const [link] = await tx.select({ id: abstractThemeLinks.id }).from(abstractThemeLinks).where(eq(abstractThemeLinks.themeId, themeId)).limit(1);
    const [reviewer] = await tx.select({ id: abstractReviewerThemes.id }).from(abstractReviewerThemes).where(eq(abstractReviewerThemes.themeId, themeId)).limit(1);
    const [counter] = await tx.select({ id: abstractCodeCounters.id }).from(abstractCodeCounters).where(eq(abstractCodeCounters.themeId, themeId)).limit(1);
    if (link || reviewer || counter) return "IN_USE" as const;
    await tx.delete(abstractThemes).where(eq(abstractThemes.id, themeId));
    return "DELETED" as const;
  });
}

/** Complete active-theme permutation; temporary negative slots avoid unique-key swap failures. */
export function reorderAbstractThemes(eventId: string, themeIds: string[]) {
  return withSerializableTxn(async (tx) => {
    const [config] = await tx.select({ id: abstractConfig.id }).from(abstractConfig)
      .where(eq(abstractConfig.eventId, eventId)).for("update");
    if (!config) return { ok: false, reason: "NOT_FOUND" } as const;
    const themes = await tx.select().from(abstractThemes).where(and(eq(abstractThemes.configId, config.id), eq(abstractThemes.active, true)))
      .orderBy(asc(abstractThemes.id)).for("update");
    if (new Set(themeIds).size !== themeIds.length || themeIds.length !== themes.length || themes.some(t => !themeIds.includes(t.id)))
      return { ok: false, reason: "INVALID_SET" } as const;
    const moved = themes.filter(t => themeIds.indexOf(t.id) !== t.sortOrder);
    if (moved.length) {
      const ids = moved.map(t => t.id);
      const [coded] = await tx.select({ id: abstracts.id }).from(abstractThemeLinks).innerJoin(abstracts, eq(abstracts.id, abstractThemeLinks.abstractId))
        .where(and(inArray(abstractThemeLinks.themeId, ids), isNotNull(abstracts.code))).limit(1);
      const [counter] = await tx.select({ id: abstractCodeCounters.id }).from(abstractCodeCounters)
        .where(and(inArray(abstractCodeCounters.themeId, ids), gt(abstractCodeCounters.lastValue, 0))).limit(1);
      if (coded || counter) return { ok: false, reason: "CODED_THEME" } as const;
      let temporary = Math.min(0, ...themes.map(t => t.sortOrder)) - 1;
      for (const theme of moved) await tx.update(abstractThemes).set({ sortOrder: temporary-- }).where(eq(abstractThemes.id, theme.id));
      for (const theme of moved) await tx.update(abstractThemes).set({ sortOrder: themeIds.indexOf(theme.id) }).where(eq(abstractThemes.id, theme.id));
    }
    const items = await tx.select().from(abstractThemes).where(eq(abstractThemes.configId, config.id)).orderBy(asc(abstractThemes.sortOrder), asc(abstractThemes.id));
    return { ok: true, items } as const;
  });
}
