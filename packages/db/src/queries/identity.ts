import { and, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { withSerializableTxn } from "../txn";
import { clients, users } from "../schema/users-clients";

export type UserRow = typeof users.$inferSelect;
// Not exported: `ClientRow` is exported from queries/clients.ts; re-exporting it
// here too would collide through the queries barrel.
type ClientRow = typeof clients.$inferSelect;
/** Legacy `UserWithClient`: the user row plus its nested client relation (or null). */
export type UserWithClient = UserRow & { client: ClientRow | null };

export interface ListUsersFilters {
  role?: number;
  clientId?: string;
  active?: boolean;
  search?: string;
}

function buildUserWhere(filters: ListUsersFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.role !== undefined) conditions.push(eq(users.role, filters.role));
  if (filters.clientId !== undefined)
    conditions.push(eq(users.clientId, filters.clientId));
  if (filters.active !== undefined)
    conditions.push(eq(users.active, filters.active));
  if (filters.search) {
    // Legacy Prisma `contains` + `mode: "insensitive"` on name OR email.
    // ponytail: raw ILIKE substring; legacy Prisma escaped LIKE wildcards, this
    // does not — only differs when the search text contains % or _ (rare).
    const pattern = `%${filters.search}%`;
    const searchOr = or(
      ilike(users.name, pattern),
      ilike(users.email, pattern),
    );
    if (searchOr) conditions.push(searchOr);
  }
  return conditions.length ? and(...conditions) : undefined;
}

function toUserWithClient(row: {
  users: UserRow;
  clients: ClientRow | null;
}): UserWithClient {
  return { ...row.users, client: row.clients };
}

/** findUnique by email. Used for the create-time uniqueness pre-check. */
export async function getUserByEmail(
  email: string,
): Promise<UserRow | undefined> {
  const [row] = await getDb().select().from(users).where(eq(users.email, email));
  return row;
}

/** findUnique by id (no client relation). */
export async function getUserById(id: string): Promise<UserRow | undefined> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id));
  return row;
}

/** findUnique by id including the client relation (null for clientless users). */
export async function getUserWithClientById(
  id: string,
): Promise<UserWithClient | undefined> {
  const [row] = await getDb()
    .select({ users, clients })
    .from(users)
    .leftJoin(clients, eq(users.clientId, clients.id))
    .where(eq(users.id, id));
  return row ? toUserWithClient(row) : undefined;
}

/** Insert a user. `id` is the app-supplied Firebase UID (no DB default). */
export async function createUser(data: {
  id: string;
  email: string;
  name: string;
  role: number;
  clientId: string | null;
}): Promise<UserRow> {
  const [row] = await getDb().insert(users).values(data).returning();
  return row;
}

/**
 * Update a user and return it with its client relation. `data` is the whole
 * validated patch (name/role/clientId/active as present) — mirrors legacy
 * `prisma.user.update({ data: input, include: { client: true } })`.
 */
export async function updateUser(
  id: string,
  data: Partial<{
    name: string;
    role: number;
    clientId: string | null;
    active: boolean;
  }>,
): Promise<UserWithClient> {
  const db = getDb();
  // Prisma ignored `undefined` keys and treated an empty patch as a no-op.
  // Drizzle's `.set({})` throws, so strip undefined and skip the write when
  // nothing remains (empty PATCH body just re-reads the row).
  // ponytail: empty body does not bump updatedAt (Prisma arguably did); rare
  // and untested — replicate the no-op read instead of forcing a write.
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined),
  );
  const [updated] =
    Object.keys(clean).length > 0
      ? await db.update(users).set(clean).where(eq(users.id, id)).returning()
      : await db.select().from(users).where(eq(users.id, id));
  const client = updated.clientId
    ? (await db.select().from(clients).where(eq(clients.id, updated.clientId)))[0] ??
      null
    : null;
  return { ...updated, client };
}

/** List users with filters, ordered by createdAt desc, plus a total count. */
export async function listUsers(
  filters: ListUsersFilters,
  skip: number,
  limit: number,
): Promise<{ data: UserWithClient[]; total: number }> {
  const db = getDb();
  const where = buildUserWhere(filters);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({ users, clients })
      .from(users)
      .leftJoin(clients, eq(users.clientId, clients.id))
      .where(where)
      .orderBy(desc(users.createdAt))
      .offset(skip)
      .limit(limit),
    db.select({ value: count() }).from(users).where(where),
  ]);

  return { data: rows.map(toUserWithClient), total: Number(totalRow.value) };
}

/** Count active super admins (role 0, active true). */
export async function countActiveSuperAdmins(
  db: DbExecutor = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.role, 0), eq(users.active, true)));
  return Number(row.value);
}

/** All user ids belonging to a client — for cache invalidation on client flips. */
export async function getUserIdsByClient(clientId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clientId, clientId));
  return rows.map((r) => r.id);
}

// ============================================================================
// Transactional delete (Serializable + retry — last-super-admin race guard)
// ============================================================================

export type DeleteUserResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: "not_found" | "last_super_admin" };

/**
 * Delete a user inside a Serializable transaction (retried on 40001/40P01),
 * atomically guarding against removing the last active super admin. Returns a
 * discriminated result — the caller maps reasons to domain errors. The
 * self-delete guard lives in the service, before this is ever called.
 */
export async function deleteUser(id: string): Promise<DeleteUserResult> {
  return withSerializableTxn(async (tx): Promise<DeleteUserResult> => {
    const [user] = await tx.select().from(users).where(eq(users.id, id));
    if (!user) return { ok: false, reason: "not_found" };

    // assertNotLastActiveSuperAdmin against { active: false }: only an
    // active super admin can trip the guard (delete => nextActive false).
    if (user.role === 0 && user.active) {
      const superAdmins = await countActiveSuperAdmins(tx);
      if (superAdmins <= 1) return { ok: false, reason: "last_super_admin" };
    }

    await tx.delete(users).where(eq(users.id, id));
    return { ok: true, user };
  });
}
