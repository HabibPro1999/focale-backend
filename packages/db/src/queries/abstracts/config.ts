/** Abstract config: the per-event row and the submission count. */
import { count, eq } from "drizzle-orm";
import { getDb, type DbExecutor } from "../../client";
import { abstractConfig, abstracts } from "../../schema/abstracts";
import type { AbstractConfigRow } from "./shared";

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
  exec: DbExecutor,
): Promise<AbstractConfigRow> {
  const [row] = await exec
    .update(abstractConfig)
    .set(data)
    .where(eq(abstractConfig.id, id))
    .returning();
  return row;
}

export async function countAbstractsByEvent(eventId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(abstracts)
    .where(eq(abstracts.eventId, eventId));
  return row?.n ?? 0;
}
