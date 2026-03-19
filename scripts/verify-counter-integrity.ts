#!/usr/bin/env bun
/**
 * Counter Integrity Verification Script
 *
 * Detects drift between denormalized registered_count columns and actual
 * registration/access counts in the database. Read-only — no writes.
 *
 * Run this before and after deploying the transaction fixes to confirm
 * whether past counter drift exists and that new registrations no longer
 * produce drift.
 *
 * Usage:
 *   bun scripts/verify-counter-integrity.ts
 *   DATABASE_URL=xxx bun scripts/verify-counter-integrity.ts
 */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });

async function checkEventCounterDrift(): Promise<number> {
  console.log("Checking Event.registeredCount drift...");

  const result = await pool.query<{
    id: string;
    name: string;
    stored_count: string;
    actual_count: string;
    drift: string;
  }>(`
    SELECT
      e.id,
      e.name,
      e.registered_count::text       AS stored_count,
      COUNT(r.id)::text              AS actual_count,
      (e.registered_count - COUNT(r.id))::text AS drift
    FROM events e
    LEFT JOIN registrations r ON r.event_id = e.id
    GROUP BY e.id, e.name, e.registered_count
    HAVING e.registered_count != COUNT(r.id)
    ORDER BY ABS(e.registered_count - COUNT(r.id)) DESC
  `);

  if (result.rows.length === 0) {
    console.log(
      "  OK - all Event.registeredCount values match actual counts\n",
    );
    return 0;
  }

  console.log(`  DRIFT DETECTED in ${result.rows.length} event(s):\n`);
  for (const row of result.rows) {
    const drift = Number(row.drift);
    console.log(`  Event: ${row.name} (${row.id})`);
    console.log(
      `    stored=${row.stored_count}  actual=${row.actual_count}  drift=${drift > 0 ? "+" : ""}${drift}`,
    );
  }
  console.log();
  return result.rows.length;
}

async function checkEventAccessCounterDrift(): Promise<number> {
  console.log("Checking EventAccess.registeredCount drift...");

  // Count actual selections per access item using ANY() — compatible with CockroachDB
  // and uses the inverted index on access_type_ids for efficiency.
  const result = await pool.query<{
    id: string;
    name: string;
    event_id: string;
    stored_count: string;
    actual_count: string;
    drift: string;
  }>(`
    SELECT
      ea.id,
      ea.name,
      ea.event_id,
      ea.registered_count::text AS stored_count,
      actual.cnt::text          AS actual_count,
      (ea.registered_count - actual.cnt)::text AS drift
    FROM event_access ea
    CROSS JOIN LATERAL (
      SELECT COUNT(*) AS cnt
      FROM registrations r
      WHERE ea.id = ANY(r.access_type_ids)
    ) actual
    WHERE ea.registered_count != actual.cnt
    ORDER BY ABS(ea.registered_count - actual.cnt) DESC
  `);

  if (result.rows.length === 0) {
    console.log(
      "  OK - all EventAccess.registeredCount values match actual counts\n",
    );
    return 0;
  }

  console.log(`  DRIFT DETECTED in ${result.rows.length} access item(s):\n`);
  for (const row of result.rows) {
    const drift = Number(row.drift);
    console.log(`  Access: ${row.name} (${row.id})  eventId=${row.event_id}`);
    console.log(
      `    stored=${row.stored_count}  actual=${row.actual_count}  drift=${drift > 0 ? "+" : ""}${drift}`,
    );
  }
  console.log();
  return result.rows.length;
}

async function run() {
  console.log("Counter Integrity Check");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  let totalDrift = 0;

  try {
    totalDrift += await checkEventCounterDrift();
  } catch (error) {
    console.error("  ERROR running Event counter check:", error, "\n");
    totalDrift++;
  }

  try {
    totalDrift += await checkEventAccessCounterDrift();
  } catch (error) {
    console.error("  ERROR running EventAccess counter check:", error, "\n");
    totalDrift++;
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (totalDrift === 0) {
    console.log(
      "\nAll counters are consistent with actual registration data.\n",
    );
  } else {
    console.log(
      "\nDrift detected. Review above before correcting counters manually.",
    );
    console.log("To fix a drifted event counter:");
    console.log(
      "  UPDATE events SET registered_count = <actual> WHERE id = '<id>';",
    );
    console.log("To fix a drifted access counter:");
    console.log(
      "  UPDATE event_access SET registered_count = <actual> WHERE id = '<id>';\n",
    );
  }

  await pool.end();
  process.exit(totalDrift === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error("Fatal error:", error);
  pool.end();
  process.exit(1);
});
