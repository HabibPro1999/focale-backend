#!/usr/bin/env bun
/**
 * Backfill: Set paymentMethod = LAB_SPONSORSHIP on sponsored registrations
 *
 * Fixes two data gaps introduced before the sponsorship-link code was patched:
 *   1. Registrations with active sponsorship linkages (sponsorship_usages) but
 *      paymentMethod IS NULL — sets paymentMethod = LAB_SPONSORSHIP.
 *   2. Fully-covered registrations (sponsorshipAmount >= totalAmount) that are
 *      still PENDING — sets paymentStatus = PAID + paidAt = now().
 *
 * Safety:
 *   - Default mode is DRY RUN (audit only, no writes).
 *   - Pass --apply to execute the updates.
 *   - Never overwrites a paymentMethod that is already set (only fills NULLs).
 *   - Never overwrites paymentStatus unless it is currently PENDING
 *     (skips VERIFYING, PAID, REFUNDED, WAIVED).
 *
 * Usage:
 *   # Audit only (dry run):
 *   DATABASE_URL=$(grep DATABASE_URL .env.prod | cut -d '=' -f2-) bun scripts/backfill-sponsorship-payment-method.ts
 *
 *   # Apply changes:
 *   DATABASE_URL=$(grep DATABASE_URL .env.prod | cut -d '=' -f2-) bun scripts/backfill-sponsorship-payment-method.ts --apply
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const applyMode = process.argv.includes("--apply");

interface SponsoredRegistration {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  event_name: string;
  total_amount: number;
  sponsorship_amount: number;
  payment_method: string | null;
  payment_status: string;
  paid_at: Date | null;
  usage_count: number;
}

async function run() {
  console.log(
    applyMode
      ? "\n=== APPLY MODE — changes will be written ===\n"
      : "\n=== DRY RUN — no changes will be made (pass --apply to execute) ===\n",
  );

  // -----------------------------------------------------------------------
  // 1. Find all registrations that have sponsorship usages linked
  // -----------------------------------------------------------------------
  const sponsored = await prisma.$queryRaw<SponsoredRegistration[]>`
    SELECT
      r.id,
      r.email,
      r.first_name,
      r.last_name,
      e.name AS event_name,
      r.total_amount,
      r.sponsorship_amount,
      r.payment_method::text AS payment_method,
      r.payment_status::text AS payment_status,
      r.paid_at,
      (SELECT COUNT(*)::int FROM sponsorship_usages su WHERE su.registration_id = r.id) AS usage_count
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    WHERE r.sponsorship_amount > 0
       OR EXISTS (SELECT 1 FROM sponsorship_usages su WHERE su.registration_id = r.id)
    ORDER BY e.name, r.email
  `;

  console.log(
    `Found ${sponsored.length} registration(s) with sponsorship linkages.\n`,
  );

  if (sponsored.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // -----------------------------------------------------------------------
  // 2. Categorize
  // -----------------------------------------------------------------------
  const needsPaymentMethod: SponsoredRegistration[] = [];
  const needsPaymentStatus: SponsoredRegistration[] = [];
  const alreadyCorrect: SponsoredRegistration[] = [];
  const skippedHasMethod: SponsoredRegistration[] = [];
  const skippedHasStatus: SponsoredRegistration[] = [];

  for (const reg of sponsored) {
    const methodMissing = reg.payment_method === null;
    const methodWrong =
      reg.payment_method !== null && reg.payment_method !== "LAB_SPONSORSHIP";
    const fullyCovered = reg.sponsorship_amount >= reg.total_amount;
    const statusPending = reg.payment_status === "PENDING";

    if (methodMissing) {
      needsPaymentMethod.push(reg);
    } else if (methodWrong) {
      skippedHasMethod.push(reg);
    }

    if (fullyCovered && statusPending) {
      needsPaymentStatus.push(reg);
    } else if (fullyCovered && reg.payment_status !== "PAID") {
      skippedHasStatus.push(reg);
    }

    if (!methodMissing && !methodWrong && !(fullyCovered && statusPending)) {
      alreadyCorrect.push(reg);
    }
  }

  // -----------------------------------------------------------------------
  // 3. Report
  // -----------------------------------------------------------------------
  console.log("--- Audit Summary ---\n");
  console.log(
    `  Registrations with sponsorship linkages:  ${sponsored.length}`,
  );
  console.log(
    `  Need paymentMethod = LAB_SPONSORSHIP:     ${needsPaymentMethod.length}`,
  );
  console.log(
    `  Need paymentStatus = PAID (fully covered): ${needsPaymentStatus.length}`,
  );
  console.log(
    `  Already correct (no changes needed):       ${alreadyCorrect.length}`,
  );
  console.log(
    `  Skipped (paymentMethod already set):        ${skippedHasMethod.length}`,
  );
  console.log(
    `  Skipped (fully covered but non-PENDING):    ${skippedHasStatus.length}`,
  );

  if (needsPaymentMethod.length > 0) {
    console.log("\n--- Will set paymentMethod = LAB_SPONSORSHIP ---\n");
    console.log(
      formatTable(needsPaymentMethod, [
        "id",
        "email",
        "event_name",
        "payment_method",
        "payment_status",
        "sponsorship_amount",
        "total_amount",
        "usage_count",
      ]),
    );
  }

  if (needsPaymentStatus.length > 0) {
    console.log(
      "\n--- Will set paymentStatus = PAID + paidAt (fully covered, currently PENDING) ---\n",
    );
    console.log(
      formatTable(needsPaymentStatus, [
        "id",
        "email",
        "event_name",
        "payment_status",
        "sponsorship_amount",
        "total_amount",
      ]),
    );
  }

  if (skippedHasMethod.length > 0) {
    console.log(
      "\n--- Skipped: paymentMethod already set to non-LAB_SPONSORSHIP ---\n",
    );
    console.log(
      formatTable(skippedHasMethod, [
        "id",
        "email",
        "event_name",
        "payment_method",
        "sponsorship_amount",
        "total_amount",
      ]),
    );
  }

  if (skippedHasStatus.length > 0) {
    console.log(
      "\n--- Skipped: fully covered but paymentStatus is not PENDING ---\n",
    );
    console.log(
      formatTable(skippedHasStatus, [
        "id",
        "email",
        "event_name",
        "payment_status",
        "sponsorship_amount",
        "total_amount",
      ]),
    );
  }

  // -----------------------------------------------------------------------
  // 4. Apply (only if --apply)
  // -----------------------------------------------------------------------
  if (!applyMode) {
    console.log(
      "\nDry run complete. Run with --apply to execute these changes.\n",
    );
    return;
  }

  console.log("\n--- Applying changes ---\n");

  // 4a. Backfill paymentMethod
  if (needsPaymentMethod.length > 0) {
    const ids = needsPaymentMethod.map((r) => r.id);
    const result = await prisma.registration.updateMany({
      where: {
        id: { in: ids },
        paymentMethod: null, // safety: re-check at write time
      },
      data: {
        paymentMethod: "LAB_SPONSORSHIP",
      },
    });
    console.log(`  Updated paymentMethod on ${result.count} registration(s).`);
  }

  // 4b. Backfill paymentStatus for fully covered
  if (needsPaymentStatus.length > 0) {
    const ids = needsPaymentStatus.map((r) => r.id);
    const result = await prisma.registration.updateMany({
      where: {
        id: { in: ids },
        paymentStatus: "PENDING", // safety: re-check at write time
      },
      data: {
        paymentStatus: "PAID",
        paidAt: new Date(),
      },
    });
    console.log(
      `  Updated paymentStatus to PAID on ${result.count} registration(s).`,
    );
  }

  console.log("\nBackfill complete.\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatTable(rows: any[], columns: string[]): string {
  if (rows.length === 0) return "  (none)";

  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => String(r[col] ?? "NULL").length)),
  );

  const header = columns.map((col, i) => col.padEnd(widths[i])).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((row) =>
      columns
        .map((col, i) => String(row[col] ?? "NULL").padEnd(widths[i]))
        .join("  "),
    )
    .join("\n  ");

  return `  ${header}\n  ${separator}\n  ${body}`;
}

run()
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
