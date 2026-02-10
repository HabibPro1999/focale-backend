#!/usr/bin/env bun
/**
 * Data Integrity Verification Script
 * Run after migrations to ensure data consistency
 *
 * Usage:
 *   bun scripts/verify-data-integrity.ts
 *   DATABASE_URL=xxx bun scripts/verify-data-integrity.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  count?: number;
}

const checks: CheckResult[] = [];

async function runChecks() {
  console.log("🔍 Running data integrity checks...\n");

  // Check 1: No orphaned registrations (event_id references exist)
  try {
    const orphanedRegistrations = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count
      FROM registrations r
      LEFT JOIN events e ON r.event_id = e.id
      WHERE e.id IS NULL
    `;
    const count = Number(orphanedRegistrations[0].count);
    checks.push({
      name: "No orphaned registrations",
      passed: count === 0,
      message:
        count === 0
          ? "All registrations have valid events"
          : `Found ${count} orphaned registrations`,
      count,
    });
  } catch (error) {
    checks.push({
      name: "No orphaned registrations",
      passed: false,
      message: `Check failed: ${error}`,
    });
  }

  // Check 2: No NULL emails in registrations
  try {
    const nullEmails = await prisma.registration.count({
      where: { email: null },
    });
    checks.push({
      name: "No NULL emails in registrations",
      passed: nullEmails === 0,
      message:
        nullEmails === 0
          ? "All registrations have emails"
          : `Found ${nullEmails} registrations without email`,
      count: nullEmails,
    });
  } catch (error) {
    checks.push({
      name: "No NULL emails in registrations",
      passed: false,
      message: `Check failed: ${error}`,
    });
  }

  // Check 3: No negative amounts
  try {
    const negativeAmounts = await prisma.registration.count({
      where: { totalAmount: { lt: 0 } },
    });
    checks.push({
      name: "No negative payment amounts",
      passed: negativeAmounts === 0,
      message:
        negativeAmounts === 0
          ? "All amounts are non-negative"
          : `Found ${negativeAmounts} negative amounts`,
      count: negativeAmounts,
    });
  } catch (error) {
    checks.push({
      name: "No negative payment amounts",
      passed: false,
      message: `Check failed: ${error}`,
    });
  }

  // Check 4: All clients have at least one user
  try {
    const clientsWithoutUsers = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count
      FROM clients c
      LEFT JOIN users u ON c.id = u.client_id
      WHERE u.id IS NULL AND c.id IS NOT NULL
    `;
    const count = Number(clientsWithoutUsers[0].count);
    checks.push({
      name: "All clients have users",
      passed: count === 0,
      message:
        count === 0
          ? "All clients have at least one user"
          : `Found ${count} clients without users`,
      count,
    });
  } catch (error) {
    checks.push({
      name: "All clients have users",
      passed: false,
      message: `Check failed: ${error}`,
    });
  }

  // Check 5: Unique email per form (business rule)
  try {
    const duplicateEmails = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count
      FROM (
        SELECT email, form_id, COUNT(*) as dup_count
        FROM registrations
        GROUP BY email, form_id
        HAVING COUNT(*) > 1
      ) dupes
    `;
    const count = Number(duplicateEmails[0].count);
    checks.push({
      name: "Unique email per form",
      passed: count === 0,
      message:
        count === 0
          ? "No duplicate email+form combinations"
          : `Found ${count} duplicate email+form pairs`,
      count,
    });
  } catch (error) {
    checks.push({
      name: "Unique email per form",
      passed: false,
      message: `Check failed: ${error}`,
    });
  }

  // Check 6: Sponsorship codes are unique
  try {
    const duplicateCodes = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count
      FROM (
        SELECT code, COUNT(*) as dup_count
        FROM sponsorships
        GROUP BY code
        HAVING COUNT(*) > 1
      ) dupes
    `;
    const count = Number(duplicateCodes[0].count);
    checks.push({
      name: "Unique sponsorship codes",
      passed: count === 0,
      message:
        count === 0
          ? "All sponsorship codes are unique"
          : `Found ${count} duplicate codes`,
      count,
    });
  } catch (error) {
    checks.push({
      name: "Unique sponsorship codes",
      passed: false,
      message: `Check failed: ${error}`,
    });
  }

  // Print results
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  let failedCount = 0;
  for (const check of checks) {
    const icon = check.passed ? "✅" : "❌";
    console.log(`${icon} ${check.name}`);
    console.log(`   ${check.message}`);
    if (!check.passed) failedCount++;
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (failedCount === 0) {
    console.log("\n✅ All integrity checks passed!\n");
    process.exit(0);
  } else {
    console.log(
      `\n❌ ${failedCount} check(s) failed. Review data integrity before proceeding.\n`,
    );
    process.exit(1);
  }
}

runChecks()
  .catch((error) => {
    console.error("💥 Fatal error running integrity checks:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
