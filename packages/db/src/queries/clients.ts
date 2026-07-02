import { and, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { clients, users } from "../schema/users-clients";
import { events } from "../schema/events-access";

export type ClientRow = typeof clients.$inferSelect;

/** Resolved create payload (optional cols already coerced to null / defaulted upstream). */
export type InsertClientData = {
  name: string;
  logo: string | null;
  primaryColor: string | null;
  email: string | null;
  phone: string | null;
  enabledModules: string[];
};

/** Column subset any module needs to gate on a client's modules (Drizzle "SELECT shape"). */
export const clientModuleGateColumns = {
  active: clients.active,
  enabledModules: clients.enabledModules,
} as const;

export const clientModuleGateWithNameColumns = {
  name: clients.name,
  ...clientModuleGateColumns,
} as const;

/** Insert a client. IDs are app-side (idPk $defaultFn); timestamps via schema helpers. */
export async function insertClient(data: InsertClientData): Promise<ClientRow> {
  const [row] = await getDb().insert(clients).values(data).returning();
  return row;
}

/** Fetch a client by id, or null. */
export async function getClientById(id: string): Promise<ClientRow | null> {
  const [row] = await getDb().select().from(clients).where(eq(clients.id, id));
  return row ?? null;
}

/** Columns updateClient may set. enabledModules omitted ⇒ column left untouched. */
export type UpdateClientData = Partial<{
  name: string;
  logo: string | null;
  primaryColor: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
  enabledModules: string[];
}>;

/** Update a client row and return it. Caller must have verified existence first. */
export async function updateClientRow(
  id: string,
  data: UpdateClientData,
): Promise<ClientRow> {
  const [row] = await getDb()
    .update(clients)
    .set(data)
    .where(eq(clients.id, id))
    .returning();
  return row;
}

export type ListClientsArgs = {
  skip: number;
  limit: number;
  active?: boolean;
  search?: string;
};

function listClientsWhere(args: ListClientsArgs): SQL | undefined {
  const conditions: SQL[] = [];
  if (args.active !== undefined) conditions.push(eq(clients.active, args.active));
  if (args.search) {
    const term = `%${args.search}%`;
    conditions.push(
      or(ilike(clients.name, term), ilike(clients.email, term)) as SQL,
    );
  }
  return conditions.length ? and(...conditions) : undefined;
}

/** Page of clients (createdAt desc) plus total matching the same filter. */
export async function listClientsPage(
  args: ListClientsArgs,
): Promise<{ data: ClientRow[]; total: number }> {
  const db = getDb();
  const where = listClientsWhere(args);

  const [data, totalRows] = await Promise.all([
    db
      .select()
      .from(clients)
      .where(where)
      .orderBy(desc(clients.createdAt))
      .limit(args.limit)
      .offset(args.skip),
    db.select({ value: count() }).from(clients).where(where),
  ]);

  return { data, total: Number(totalRows[0].value) };
}

/** Hard-delete a client row. */
export async function deleteClientRow(id: string): Promise<void> {
  await getDb().delete(clients).where(eq(clients.id, id));
}

/** Whether a client row with this id exists. Mirrors legacy `prisma.client.count > 0`. */
export async function clientExists(id: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ value: count() })
    .from(clients)
    .where(eq(clients.id, id));
  return Number(row.value) > 0;
}

/**
 * Existence + dependency counts for deleteClient. Returns null when the client
 * does not exist. Mirrors legacy findUnique+_count{users,events} (emailTemplates
 * intentionally NOT counted — legacy parity).
 */
export async function getClientDeletionInfo(
  id: string,
): Promise<{ userCount: number; eventCount: number } | null> {
  const db = getDb();
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, id));
  if (!client) return null;

  const [userRow, eventRow] = await Promise.all([
    db.select({ value: count() }).from(users).where(eq(users.clientId, id)),
    db.select({ value: count() }).from(events).where(eq(events.clientId, id)),
  ]);

  return {
    userCount: Number(userRow[0].value),
    eventCount: Number(eventRow[0].value),
  };
}

/** Projection used by module-gate checks. Mirrors legacy CLIENT_MODULE_GATE_SELECT. */
export async function findClientModuleState(
  id: string,
  executor: DbExecutor = getDb(),
): Promise<{ active: boolean; enabledModules: string[] | null } | null> {
  const [row] = await executor
    .select(clientModuleGateColumns)
    .from(clients)
    .where(eq(clients.id, id));
  return row ?? null;
}
