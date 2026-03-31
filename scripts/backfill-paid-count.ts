#!/usr/bin/env bun
/**
 * Backfill paid_count on event_access
 *
 * Computes the correct paid_count for each access item by counting
 * PAID/WAIVED registrations that selected it (using priceBreakdown
 * for accurate quantity including companions).
 *
 * Usage:
 *   bun scripts/backfill-paid-count.ts           # dry run
 *   bun scripts/backfill-paid-count.ts --apply    # apply changes
 *   DATABASE_URL=xxx bun scripts/backfill-paid-count.ts --apply
 */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const dryRun = !process.argv.includes("--apply");
if (dryRun) {
  console.log("DRY RUN — pass --apply to write changes\n");
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });

interface AccessCount {
  accessId: string;
  totalQuantity: number;
}

async function backfillPaidCount(): Promise<void> {
  // Fetch all PAID/WAIVED registrations with their priceBreakdown
  const result = await pool.query<{
    id: string;
    event_id: string;
    price_breakdown: {
      accessItems?: Array<{ accessId: string; quantity: number }>;
    };
  }>(`
    SELECT id, event_id, price_breakdown
    FROM registrations
    WHERE payment_status IN ('PAID', 'WAIVED')
    AND price_breakdown IS NOT NULL
  `);

  console.log(`Found ${result.rows.length} PAID/WAIVED registrations\n`);

  // Aggregate quantity per access item
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const accessItems = row.price_breakdown?.accessItems ?? [];
    for (const item of accessItems) {
      const current = counts.get(item.accessId) ?? 0;
      counts.set(item.accessId, current + (item.quantity ?? 1));
    }
  }

  if (counts.size === 0) {
    console.log("No access items to update.");
    return;
  }

  // Fetch current paid_count for comparison
  const accessIds = Array.from(counts.keys());
  const currentCounts = await pool.query<{
    id: string;
    name: string;
    paid_count: number;
    registered_count: number;
    max_capacity: number | null;
  }>(`
    SELECT id, name, paid_count, registered_count, max_capacity
    FROM event_access
    WHERE id = ANY($1)
  `, [accessIds]);

  const currentMap = new Map(currentCounts.rows.map((r) => [r.id, r]));

  console.log("Access item paid_count updates:\n");
  console.log(
    "ID".padEnd(40),
    "Name".padEnd(30),
    "Current".padEnd(10),
    "Correct".padEnd(10),
    "Drift".padEnd(10),
  );
  console.log("-".repeat(100));

  let updates = 0;
  for (const [accessId, correctCount] of counts) {
    const current = currentMap.get(accessId);
    const currentPaidCount = current?.paid_count ?? 0;
    const drift = correctCount - currentPaidCount;

    if (drift !== 0) {
      console.log(
        accessId.padEnd(40),
        (current?.name ?? "???").padEnd(30),
        String(currentPaidCount).padEnd(10),
        String(correctCount).padEnd(10),
        (drift > 0 ? `+${drift}` : String(drift)).padEnd(10),
      );
      updates++;
    }
  }

  if (updates === 0) {
    console.log("\nAll paid_count values are already correct!");
    return;
  }

  console.log(`\n${updates} access items need updating.`);

  if (dryRun) {
    console.log("\nRe-run with --apply to write changes.");
    return;
  }

  // Apply updates
  console.log("\nApplying updates...");
  for (const [accessId, correctCount] of counts) {
    const current = currentMap.get(accessId);
    if (current && current.paid_count !== correctCount) {
      await pool.query(
        `UPDATE event_access SET paid_count = $1 WHERE id = $2`,
        [correctCount, accessId],
      );
    }
  }
  console.log(`Done. Updated ${updates} access items.`);
}

async function main(): Promise<void> {
  try {
    await backfillPaidCount();
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
