// Stand-ins for packages/db (client.ts, drizzle's sql) used by the
// focale/explicit-write-executor rule tests. The rule recognises an executor
// by its select/insert/update/delete/execute members, as it does DbExecutor.

interface Builder extends PromiseLike<unknown[]> {
  values(values: unknown): Builder;
  set(values: unknown): Builder;
  where(condition: unknown): Builder;
  from(table: unknown): Builder;
  for(strength: "update" | "share"): Builder;
  returning(): Builder;
}

interface Db {
  select(fields?: unknown): Builder;
  insert(table: unknown): Builder;
  update(table: unknown): Builder;
  delete(table: unknown): Builder;
  execute(query: unknown): Promise<unknown>;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
interface Tx extends Omit<Db, "transaction"> {
  rollback(): never;
}
export type DbExecutor = Db | Tx;

export declare function getDb(): Db;
export declare function sql(strings: TemplateStringsArray, ...values: unknown[]): unknown;
export declare namespace sql {
  function raw(text: string): unknown;
}
export declare const auditLogs: unknown;

/** A write in another file, reached only through a call. */
export async function insertAudit(values: unknown, exec: DbExecutor): Promise<void> {
  await exec.insert(auditLogs).values(values);
}

/** A read in another file. */
export async function readAudit(exec: DbExecutor): Promise<unknown> {
  return exec.select().from(auditLogs);
}
