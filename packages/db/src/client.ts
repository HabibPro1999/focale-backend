import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

let pool: Pool | undefined;
let db: ReturnType<typeof drizzle> | undefined;

function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

/** Lazy singleton drizzle client. Throws if DATABASE_URL unset. */
export function getDb() {
  if (!db) {
    db = drizzle(getPool(), { casing: "snake_case" });
  }
  return db;
}

export type Db = ReturnType<typeof getDb>;
/** A db handle or an open transaction — helpers ride the caller's txn. */
export type DbExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Bounded readiness check. Returns false on timeout/error; never throws. */
export async function pingDb(timeoutMs = 2000): Promise<boolean> {
  try {
    const client = await getPool().connect();
    try {
      const timer = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pingDb timeout")), timeoutMs),
      );
      await Promise.race([client.query("select 1"), timer]);
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}
