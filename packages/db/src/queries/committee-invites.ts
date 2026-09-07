import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { withSerializableTxn } from "../txn";
import { committeeInviteTokens as tokens } from "../schema/abstracts";
import { users } from "../schema/users-clients";
import { events } from "../schema/events-access";

type NewInvite = typeof tokens.$inferInsert;
export async function insertCommitteeInvite(
  data: NewInvite,
  db: DbExecutor = getDb(),
) {
  const [row] = await db.insert(tokens).values(data).returning();
  return row;
}
export async function deleteUnusedCommitteeInvites(
  userId: string,
  eventId?: string,
  exceptId?: string,
  db: DbExecutor = getDb(),
) {
  await db
    .delete(tokens)
    .where(
      and(
        eq(tokens.userId, userId),
        isNull(tokens.usedAt),
        eventId ? eq(tokens.eventId, eventId) : undefined,
        exceptId ? ne(tokens.id, exceptId) : undefined,
      ),
    );
}
export function replaceCommitteeInvite(data: NewInvite) {
  return withSerializableTxn(async (tx) => {
    await deleteUnusedCommitteeInvites(
      data.userId,
      data.eventId,
      undefined,
      tx,
    );
    return insertCommitteeInvite(data, tx);
  });
}
export async function findCommitteeInviteByHash(hash: string) {
  const [row] = await getDb()
    .select({
      invite: tokens,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        active: users.active,
        role: users.role,
      },
      event: { name: events.name },
    })
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .innerJoin(events, eq(tokens.eventId, events.id))
    .where(eq(tokens.tokenHash, hash))
    .limit(1);
  return row ? { ...row.invite, user: row.user, event: row.event } : null;
}
export async function findCommitteeInviteById(id: string) {
  const [row] = await getDb()
    .select()
    .from(tokens)
    .where(eq(tokens.id, id))
    .limit(1);
  return row ?? null;
}
export async function claimCommitteeInvite(id: string, now: Date) {
  const rows = await getDb()
    .update(tokens)
    .set({ usedAt: now })
    .where(
      and(eq(tokens.id, id), isNull(tokens.usedAt), gt(tokens.expiresAt, now)),
    )
    .returning({ id: tokens.id });
  return rows.length === 1;
}
export function releaseCommitteeInvite(
  invite: { id: string; userId: string; eventId: string },
  claimedAt: Date,
) {
  return withSerializableTxn(async (tx) => {
    const [superseder] = await tx
      .select({ id: tokens.id })
      .from(tokens)
      .where(
        and(
          eq(tokens.userId, invite.userId),
          eq(tokens.eventId, invite.eventId),
          isNull(tokens.usedAt),
          ne(tokens.id, invite.id),
        ),
      )
      .limit(1);
    const claim = and(eq(tokens.id, invite.id), eq(tokens.usedAt, claimedAt));
    if (superseder) await tx.delete(tokens).where(claim);
    else await tx.update(tokens).set({ usedAt: null }).where(claim);
  });
}
export async function discardCommitteeInvite(id: string) {
  await getDb()
    .delete(tokens)
    .where(and(eq(tokens.id, id), isNull(tokens.usedAt)));
}
