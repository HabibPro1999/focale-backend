import { and, asc, eq, isNull, type InferSelectModel } from "drizzle-orm";
import type { StoredBadgeZones } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { badgeTemplates } from "../schema/badges";
import { checkBadgeTemplateRow } from "./stored-json";

// Badge templates (0042). Every read and write leaves soft-deleted rows out.

export type BadgeTemplateRow = InferSelectModel<typeof badgeTemplates>;

/** The background image columns, all set together on upload and cleared together on removal. */
export interface BadgeTemplateBackground {
  backgroundUrl: string;
  backgroundWidth: number;
  backgroundHeight: number;
  renderImageKey: string;
  renderImageWidth: number;
  renderImageHeight: number;
}

const active = (id: string) => and(eq(badgeTemplates.id, id), isNull(badgeTemplates.deletedAt));

/** The event's badges, oldest first. */
export async function listBadgeTemplates(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<BadgeTemplateRow[]> {
  const rows = await exec
    .select()
    .from(badgeTemplates)
    .where(and(eq(badgeTemplates.eventId, eventId), isNull(badgeTemplates.deletedAt)))
    .orderBy(asc(badgeTemplates.createdAt), asc(badgeTemplates.id));
  return rows.map(checkBadgeTemplateRow);
}

/** One badge, or null when it does not exist or was deleted. */
export async function getBadgeTemplate(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<BadgeTemplateRow | null> {
  const [row] = await exec.select().from(badgeTemplates).where(active(id)).limit(1);
  return row ? checkBadgeTemplateRow(row) : null;
}

export async function createBadgeTemplate(
  values: {
    eventId: string;
    name: string;
    widthMm: number;
    heightMm: number;
    zones: StoredBadgeZones;
  },
  exec: DbExecutor,
): Promise<BadgeTemplateRow> {
  const [row] = await exec.insert(badgeTemplates).values(values).returning();
  return row!;
}

/** Write the fields `patch` defines; null when the badge is gone. */
export async function updateBadgeTemplate(
  id: string,
  patch: {
    name?: string;
    widthMm?: number;
    heightMm?: number;
    zones?: StoredBadgeZones;
  },
  exec: DbExecutor,
): Promise<BadgeTemplateRow | null> {
  const set: Partial<typeof badgeTemplates.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.widthMm !== undefined) set.widthMm = patch.widthMm;
  if (patch.heightMm !== undefined) set.heightMm = patch.heightMm;
  if (patch.zones !== undefined) set.zones = patch.zones;
  const [row] = await exec.update(badgeTemplates).set(set).where(active(id)).returning();
  return row ?? null;
}

/** Set the background images, or clear them (null); null when the badge is gone. */
export async function setBadgeTemplateBackground(
  id: string,
  background: BadgeTemplateBackground | null,
  exec: DbExecutor,
): Promise<BadgeTemplateRow | null> {
  const [row] = await exec
    .update(badgeTemplates)
    .set(
      background ?? {
        backgroundUrl: null,
        backgroundWidth: null,
        backgroundHeight: null,
        renderImageKey: null,
        renderImageWidth: null,
        renderImageHeight: null,
      },
    )
    .where(active(id))
    .returning();
  return row ?? null;
}

/** Soft delete; false when the badge was already gone. Its images stay until the event is deleted. */
export async function deleteBadgeTemplate(id: string, exec: DbExecutor): Promise<boolean> {
  const rows = await exec
    .update(badgeTemplates)
    .set({ deletedAt: new Date() })
    .where(active(id))
    .returning({ id: badgeTemplates.id });
  return rows.length > 0;
}
