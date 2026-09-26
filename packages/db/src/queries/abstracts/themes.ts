/** Abstract themes: CRUD and the printed-code guard on sortOrder moves. */
import { and, asc, count, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../client";
import {
  abstractConfig,
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
