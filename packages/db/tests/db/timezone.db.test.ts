// Empirical proof of the timezone-correctness fix (client.ts): naive-UTC
// `timestamp` columns must round-trip to the same instant through both the
// drizzle ORM path (.select) and the raw-SQL path (.execute), and JS-computed
// ages of a just-inserted row must be ~0 even when the process runs in a
// non-UTC zone. Before the fix, the raw path skewed by the host offset (~1h on
// UTC+1) because node-postgres parses OID 1114 as process-local.
//
// This is in the guarded real-DB tier. setup.db gives each file its own
// disposable migrated database before the first query. The pool here is
// rebuilt from a hostile DATABASE_URL whose `options` asks for another zone:
// the client must still pin UTC (client.ts / connection-config.ts). The second
// block proves the pool's statement/idle-in-transaction timeouts, its
// application_name and the export override on the real engine.
//
// Force a non-UTC process TZ; Node re-reads process.env.TZ per Date op.
process.env.TZ = "Africa/Tunis";

import { sql } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// client reads DATABASE_URL lazily inside getPool(), so a static import is fine
// because the real-DB setup assigns it before beforeAll executes.
import { closeDb, configureDb, getDb } from "../../src/client";
import { pgErrorCode, withExportStatementTimeout } from "../../src/txn";
import { dbTestsEnabled } from "../helpers/test-env";

const APPLICATION_NAME = "focale-db-test";

/** Same scratch database, plus query parameters that try to override the pool. */
function hostileUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(
    "options",
    "-c TimeZone=America/New_York -c statement_timeout=0 -c search_path=public",
  );
  parsed.searchParams.set("application_name", "from-url");
  return parsed.toString();
}

async function show(setting: string): Promise<string> {
  const res = await getDb().execute(sql.raw(`SHOW ${setting}`));
  const row = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0]!;
  return String(Object.values(row)[0]);
}

/** PostgreSQL prints "1500ms"/"10s"/"1min"; CockroachDB prints milliseconds. */
function asMilliseconds(value: string): number {
  const match = /^(\d+)\s*(ms|s|min)?$/.exec(value.trim());
  if (!match) throw new Error(`Unexpected timeout value ${value}`);
  const scale = match[2] === "min" ? 60_000 : match[2] === "s" ? 1000 : 1;
  return Number(match[1]) * scale;
}

const SESSION_ENV = [
  "DB_POOL_MAX",
  "DB_STATEMENT_TIMEOUT_MS",
  "DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
  "DB_EXPORT_STATEMENT_TIMEOUT_MS",
] as const;

// Mirror the production schema: naive `timestamp` (no tz), ms precision, with a
// DEFAULT now() column and a $defaultFn (JS Date) column — exactly helpers.ts.
const probe = pgTable("tz_correctness_probe", {
  id: text().primaryKey(),
  createdAt: timestamp({ precision: 3 }).defaultNow().notNull(),
  fnAt: timestamp({ precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

describe.runIf(dbTestsEnabled())("timezone correctness (real database)", () => {
  beforeAll(async () => {
    // Rebuild the file's pool from the hostile URL (setup.db may have built one).
    await closeDb();
    process.env.DATABASE_URL = hostileUrl(process.env.DATABASE_URL!);
    configureDb({ applicationName: APPLICATION_NAME });
    await getDb().execute(sql`select 1`);
    await getDb().execute(sql`
      create table tz_correctness_probe (
        id text primary key,
        created_at timestamp(3) not null default now(),
        fn_at timestamp(3) not null
      )`);
  });

  afterAll(async () => {
    await getDb().execute(sql`drop table if exists tz_correctness_probe`);
  });

  it("process runs in a non-UTC zone (offset != 0)", () => {
    expect(new Date().getTimezoneOffset()).not.toBe(0);
  });

  it("pins the pool session to UTC despite ?options=-c TimeZone=America/New_York", async () => {
    expect((await show("TIME ZONE")).toUpperCase()).toBe("UTC");
    expect(await show("application_name")).toBe(APPLICATION_NAME);
    // Carried non-pinned options still apply; the URL's statement_timeout=0 does not.
    expect(await show("search_path")).toBe("public");
    expect(asMilliseconds(await show("statement_timeout"))).toBe(60_000);
    expect(asMilliseconds(await show("idle_in_transaction_session_timeout"))).toBe(60_000);
  });

  it("drizzle write → read back yields the same instant (stored value is UTC wall)", async () => {
    const at = new Date();
    await getDb().insert(probe).values({ id: "rw", fnAt: at });

    // ORM read: drizzle appends "+0000" to the naive value, so it parses as UTC
    // regardless of process TZ — this is the path production code reads through.
    const [orm] = await getDb().select().from(probe).where(sql`id = 'rw'`);
    expect(new Date(orm.fnAt).getTime()).toBe(at.getTime());

    // Raw .execute read: drizzle overrides the pg type parser to return the
    // bare naive string ("2026-… …") — it does NOT go through pg-types, so a
    // global setTypeParser can't fix it (proven empirically). Because the
    // session is pinned to UTC, that naive string IS the UTC wall time:
    // interpreting it as UTC round-trips to the same instant, proving the write
    // stored UTC (not host-local) wall time.
    const res = await getDb().execute(
      sql`select fn_at from tz_correctness_probe where id = 'rw'`,
    );
    const raw = (res as unknown as { rows: Array<{ fn_at: string }> }).rows[0]
      .fn_at;
    expect(typeof raw).toBe("string");
    const asUtc = new Date(`${raw.replace(" ", "T")}Z`).getTime();
    // ms precision: the DB truncates sub-ms, so allow <1ms slack.
    expect(Math.abs(asUtc - at.getTime())).toBeLessThan(1000);

    // The trap this whole fix guards against: JS-parsing the naive string
    // WITHOUT the UTC marker skews by exactly the host offset — which is why
    // the *Health fns compute ages in SQL, never by parsing .execute results.
    const skewMs = Math.abs(new Date(raw).getTime() - at.getTime());
    const offsetMs = Math.abs(new Date().getTimezoneOffset()) * 60_000;
    expect(Math.abs(skewMs - offsetMs)).toBeLessThan(1000);
  });

  it("DEFAULT now() row and $defaultFn (JS Date) row agree within tolerance", async () => {
    // createdAt via DEFAULT now() (server, UTC-pinned session); fnAt via JS Date.
    await getDb().insert(probe).values({ id: "def", fnAt: new Date() });
    const [row] = await getDb().select().from(probe).where(sql`id = 'def'`);
    const created = new Date(row.createdAt).getTime();
    const fn = new Date(row.fnAt).getTime();
    // Same "now"; must agree within clock+network jitter, not the ~1h TZ offset.
    expect(Math.abs(created - fn)).toBeLessThan(5000);
  });

  it("age of a just-inserted now() row is ~0 despite Africa/Tunis TZ", async () => {
    // Insert via raw SQL now() (timestamptz coerced into a naive column using
    // the session TimeZone — the exact write the verifier flagged as skewing on
    // non-UTC hosts). With the session pinned UTC it stores UTC wall time.
    await getDb().execute(
      sql`insert into tz_correctness_probe (id, fn_at) values ('fresh', now())`,
    );

    // JS-computed age via the ORM read (UTC-correct Date): TZ-immune, ~0.
    const [row] = await getDb().select().from(probe).where(sql`id = 'fresh'`);
    expect(Math.abs(Date.now() - new Date(row.createdAt).getTime())).toBeLessThan(
      5000,
    );

    // SQL-computed age (the pattern the *Health fns use): also ~0, and never
    // touches JS timestamp parsing.
    const res = await getDb().execute(
      sql`select extract(epoch from (now() - created_at)) * 1000 as age_ms
          from tz_correctness_probe where id = 'fresh'`,
    );
    const ageMs = Number(
      (res as unknown as { rows: Array<{ age_ms: string | number }> }).rows[0]
        .age_ms,
    );
    expect(Math.abs(ageMs)).toBeLessThan(5000);
  });
});

describe.runIf(dbTestsEnabled())("application pool session limits (real database)", () => {
  const saved = Object.fromEntries(SESSION_ENV.map((key) => [key, process.env[key]]));

  beforeAll(async () => {
    await closeDb();
    // One connection, so the override test observes the same session afterwards.
    process.env.DB_POOL_MAX = "1";
    process.env.DB_STATEMENT_TIMEOUT_MS = "1500";
    process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = "1000";
    process.env.DB_EXPORT_STATEMENT_TIMEOUT_MS = "10000";
  });

  afterAll(async () => {
    await closeDb();
    for (const key of SESSION_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("applies the configured statement and idle-in-transaction timeouts", async () => {
    expect(asMilliseconds(await show("statement_timeout"))).toBe(1500);
    expect(asMilliseconds(await show("idle_in_transaction_session_timeout"))).toBe(1000);
    expect(await show("application_name")).toBe(APPLICATION_NAME);
  });

  it("cancels a statement that exceeds DB_STATEMENT_TIMEOUT_MS", async () => {
    const error = await getDb()
      .execute(sql`select pg_sleep(3)`)
      .then(() => undefined, (caught: unknown) => caught);
    expect(pgErrorCode(error)).toBe("57014");
  });

  it("lets an export transaction run longer, then restores the session default", async () => {
    const insideTimeout = await withExportStatementTimeout(async (tx) => {
      await tx.execute(sql`select pg_sleep(2.5)`);
      const res = await tx.execute(sql`SHOW statement_timeout`);
      const row = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0]!;
      return String(Object.values(row)[0]);
    });
    expect(asMilliseconds(insideTimeout)).toBe(10_000);
    // SET LOCAL ended with the transaction on the single pooled connection.
    expect(asMilliseconds(await show("statement_timeout"))).toBe(1500);
  });

  it("terminates a transaction left idle and keeps the process and pool usable", async () => {
    const error = await getDb()
      .transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        await sleep(2500);
        await tx.execute(sql`select 1`);
      })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    // The terminated client emitted 'error' while checked out; the pool's
    // per-client listener absorbed it and a fresh connection serves the next query.
    const res = await getDb().execute(sql`select 1 as ok`);
    expect((res as unknown as { rows: Array<{ ok: unknown }> }).rows[0]!.ok).toBeTruthy();
  });
});
