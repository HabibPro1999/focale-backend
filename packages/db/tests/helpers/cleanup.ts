import { getDb } from "@app/db";
import {
  abstractBookJobs,
  abstractCodeCounters,
  abstractCodeSequences,
  abstractCommitteeMemberships,
  abstractConfig,
  abstractReviewerThemes,
  abstractReviews,
  abstractRevisions,
  abstractThemeLinks,
  abstractThemes,
  abstracts,
  accessCheckIns,
  accessPrerequisites,
  auditLogs,
  certificateTemplates,
  clients,
  emailLogs,
  emailTemplates,
  eventAccess,
  eventPricing,
  events,
  forms,
  outboxEvents,
  paymentTransaction,
  registrations,
  sponsorshipBatches,
  sponsorshipUsages,
  sponsorships,
  users,
} from "@app/db";

// FK-ordered delete, ported from legacy tests/helpers/test-app.cleanupDatabase
// and extended to the full 29-table Drizzle schema. Children are deleted before
// parents because several parent FKs use ON DELETE RESTRICT (registrations →
// forms → events), so a blanket delete in the wrong order would fail. Ordered
// leaf → root; no TRUNCATE (keeps it usable inside a plain connection/txn).
const DELETION_ORDER = [
  accessCheckIns,
  paymentTransaction,
  sponsorshipUsages,
  abstractReviews,
  abstractRevisions,
  abstractThemeLinks,
  abstractReviewerThemes,
  abstractCommitteeMemberships,
  abstractCodeCounters,
  abstractBookJobs,
  abstractThemes,
  abstracts,
  abstractConfig,
  abstractCodeSequences,
  sponsorships,
  sponsorshipBatches,
  accessPrerequisites,
  certificateTemplates,
  emailLogs,
  emailTemplates,
  auditLogs,
  outboxEvents,
  registrations,
  forms,
  eventAccess,
  eventPricing,
  events,
  users,
  clients,
] as const;

export async function cleanupDatabase(): Promise<void> {
  const db = getDb();
  for (const table of DELETION_ORDER) {
    await db.delete(table);
  }
}
