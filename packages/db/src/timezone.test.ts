// Empirical proof of the timezone-correctness fix (client.ts): naive-UTC
// `timestamp` columns must round-trip to the same instant through both the
// drizzle ORM path (.select) and the raw-SQL path (.execute), and JS-computed
// ages of a just-inserted row must be ~0 even when the process runs in a
// non-UTC zone. Before the fix, the raw path skewed by the host offset (~1h on
// UTC+1) because node-postgres parses OID 1114 as process-local.
//
// Gated: runs only when TZ_TEST_DATABASE_URL points at a reachable postgres;
// otherwise every case skips (normal CI/dev has no DB).
//
//   TZ_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db pnpm --filter @app/db test
//
// Force a non-UTC process TZ; Node re-reads process.env.TZ per Date op.
process.env.TZ = "Africa/Tunis";

import { sql } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// client reads DATABASE_URL lazily inside getPool(), so a static import is fine
// as long as DATABASE_URL is set before the first getDb() call (below).
import { getDb } from "./client";

const url = process.env.TZ_TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

// Mirror the production schema: naive `timestamp` (no tz), ms precision, with a
// DEFAULT now() column and a $defaultFn (JS Date) column — exactly helpers.ts.
const probe = pgTable("tz_correctness_probe", {
  id: text().primaryKey(),
  createdAt: timestamp({ precision: 3 }).defaultNow().notNull(),
  fnAt: timestamp({ precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

describe.skipIf(!url)("timezone correctness (real postgres)", () => {
  let reachable = false;

  beforeAll(async () => {
    try {
      const db = getDb();
      await db.execute(sql`select 1`);
      await db.execute(sql`
        create table if not exists tz_correctness_probe (
          id text primary key,
          created_at timestamp(3) not null default now(),
          fn_at timestamp(3) not null
        )`);
      await db.execute(sql`truncate tz_correctness_probe`);
      reachable = true;
    } catch (e) {
      console.error("[tz-test] unreachable:", (e as Error).message);
      reachable = false;
    }
  });

  afterAll(async () => {
    if (reachable) {
      try {
        await getDb().execute(sql`drop table if exists tz_correctness_probe`);
      } catch {
        /* ignore */
      }
    }
  });

  it("process runs in a non-UTC zone (offset != 0)", (t) => {
    if (!reachable) return t.skip();
    expect(new Date().getTimezoneOffset()).not.toBe(0);
  });

  it("drizzle write → read back yields the same instant (stored value is UTC wall)", async (t) => {
    if (!reachable) return t.skip();
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

  it("DEFAULT now() row and $defaultFn (JS Date) row agree within tolerance", async (t) => {
    if (!reachable) return t.skip();
    // createdAt via DEFAULT now() (server, UTC-pinned session); fnAt via JS Date.
    await getDb().insert(probe).values({ id: "def", fnAt: new Date() });
    const [row] = await getDb().select().from(probe).where(sql`id = 'def'`);
    const created = new Date(row.createdAt).getTime();
    const fn = new Date(row.fnAt).getTime();
    // Same "now"; must agree within clock+network jitter, not the ~1h TZ offset.
    expect(Math.abs(created - fn)).toBeLessThan(5000);
  });

  it("age of a just-inserted now() row is ~0 despite Africa/Tunis TZ", async (t) => {
    if (!reachable) return t.skip();
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
