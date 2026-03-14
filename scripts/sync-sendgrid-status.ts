#!/usr/bin/env bun
/**
 * One-time sync: pull SendGrid suppression lists (blocks, bounces, invalid emails)
 * and update email_logs that are stuck at SENT/QUEUED/SENDING.
 *
 * Usage:
 *   DATABASE_URL=xxx bun scripts/sync-sendgrid-status.ts            # dry run
 *   DATABASE_URL=xxx bun scripts/sync-sendgrid-status.ts --apply    # apply changes
 */

import 'dotenv/config';
import pg from 'pg';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SENDGRID_API_KEY) { console.error("SENDGRID_API_KEY required"); process.exit(1); }
if (!DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }

const dryRun = !process.argv.includes("--apply");
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

interface SuppressionEntry {
  email: string;
  reason?: string;
  status?: string;
  created: number;
}

async function fetchSendGridList(endpoint: string): Promise<SuppressionEntry[]> {
  const results: SuppressionEntry[] = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const res = await fetch(
      `https://api.sendgrid.com/v3/suppression/${endpoint}?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${SENDGRID_API_KEY}` } },
    );
    if (!res.ok) {
      console.error(`Failed to fetch ${endpoint}: ${res.status} ${await res.text()}`);
      return results;
    }
    const batch: SuppressionEntry[] = await res.json();
    if (batch.length === 0) break;
    results.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return results;
}

async function main() {
  console.log(dryRun ? "DRY RUN — pass --apply to commit changes\n" : "APPLYING CHANGES\n");

  console.log("Fetching SendGrid suppression lists...");
  const [blocks, bounces, invalidEmails] = await Promise.all([
    fetchSendGridList("blocks"),
    fetchSendGridList("bounces"),
    fetchSendGridList("invalid_emails"),
  ]);

  console.log(`  Blocks: ${blocks.length}`);
  console.log(`  Bounces: ${bounces.length}`);
  console.log(`  Invalid emails: ${invalidEmails.length}\n`);

  const suppressions = new Map<string, { type: string; reason: string }>();
  for (const b of blocks) {
    suppressions.set(b.email, { type: "DROPPED", reason: b.reason || "Blocked by SendGrid" });
  }
  for (const b of bounces) {
    suppressions.set(b.email, { type: "BOUNCED", reason: b.reason || b.status || "Bounced" });
  }
  for (const b of invalidEmails) {
    suppressions.set(b.email, { type: "DROPPED", reason: b.reason || "Invalid email" });
  }

  if (suppressions.size === 0) {
    console.log("No suppressions found. Nothing to sync.");
    await pool.end();
    return;
  }

  console.log(`Total unique suppressed emails: ${suppressions.size}`);

  // Find stuck logs matching suppressed emails
  const emails = [...suppressions.keys()];
  const placeholders = emails.map((_, i) => `$${i + 1}`).join(", ");
  const { rows: stuckLogs } = await pool.query(
    `SELECT id, recipient_email, subject, status FROM email_logs
     WHERE status IN ('SENT', 'QUEUED', 'SENDING')
     AND recipient_email IN (${placeholders})
     ORDER BY queued_at DESC`,
    emails,
  );

  if (stuckLogs.length === 0) {
    console.log("No stuck email logs match suppressed addresses. All good.");
    await pool.end();
    return;
  }

  console.log(`\nFound ${stuckLogs.length} email logs to update:\n`);

  for (const log of stuckLogs) {
    const suppression = suppressions.get(log.recipient_email)!;
    console.log(
      `  ${log.recipient_email} | ${log.subject.slice(0, 40)}... | ${log.status} -> ${suppression.type} | ${suppression.reason}`,
    );

    if (!dryRun) {
      await pool.query(
        `UPDATE email_logs SET status = $1, error_message = $2${suppression.type === "BOUNCED" ? ", bounced_at = NOW()" : ""} WHERE id = $3`,
        [suppression.type, `${suppression.reason} (retroactive sync)`, log.id],
      );
    }
  }

  console.log(dryRun ? "\nDry run complete. Run with --apply to commit." : `\nUpdated ${stuckLogs.length} records.`);
  await pool.end();
}

main().catch((err) => {
  console.error("Script failed:", err);
  pool.end();
  process.exit(1);
});
