import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

let pool: Pool | undefined;
let db: ReturnType<typeof drizzle> | undefined;

function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // Pin the session to UTC. Our timestamp columns are `without time zone`
    // holding naive-UTC wall time (helpers.ts): drizzle writes via toISOString
    // (always UTC wall), so DEFAULT now() must match. On a non-UTC DB server,
    // coercing now() (timestamptz) into a naive column uses the session TimeZone
    // — pinning UTC keeps now() rows and $defaultFn rows on the same clock.
    // (Reads: the drizzle ORM path parses naive timestamps as UTC; the raw
    // db.execute path returns them as unparsed strings, so any time math on
    // db.execute results is done in SQL — see the *Health fns. Proven in
    // timezone.test.ts.)
    pool = new Pool({
      connectionString: url,
      options: "-c TimeZone=UTC",
      // Pool sizing/timeouts mirror the legacy src/database/client.ts config
      // (and app-config's database.poolSize: 20 prod / 5 dev). Without these,
      // node-postgres defaults to max=10 and connectionTimeoutMillis=0 —
      // i.e. half the intended prod concurrency and connect() waiting forever
      // when the pool is exhausted or the DB is down.
      max: process.env.NODE_ENV === "production" ? 20 : 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
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
