-- migrate: transaction per-statement
-- migrate: idempotent
-- migrate: verify SELECT count(*) = 2 FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND indexname IN ('email_logs_registration_trigger_active_key', 'email_logs_template_recipient_trigger_active_key') AND indexdef LIKE '%CERTIFICATE_SENT%'
-- Certificate emails (2.12) leave the two per-trigger dedupe indexes from
-- 0001_raw_indexes.sql. A registrant legitimately gets a second certificate
-- email when a new certificate template is added, and one recipient address
-- legitimately gets several (two abstracts, or a registration plus an
-- abstract). Certificate sends dedupe per certificate template instead, under
-- the event lock (queueCertificateEmailLogsTxn).
--
-- Each index is rebuilt under a temporary name, the old one dropped, and the
-- new one renamed, so the non-certificate triggers stay covered throughout and
-- the names that application code matches on (createEmailLog) do not change.
-- One statement per transaction: CockroachDB must commit each schema change
-- before the next statement uses the name. A rerun after a crash finishes the
-- remaining steps (or rebuilds once more), ending in the same state.
CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_registration_trigger_active_key_rebuild"
  ON "email_logs" ("registration_id", "trigger")
  WHERE "registration_id" IS NOT NULL
    AND "trigger" IS NOT NULL
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED')
    AND "queued_at" >= TIMESTAMP '2026-05-29 00:03:03'
    AND "trigger" <> 'CERTIFICATE_SENT';
--> statement-breakpoint
DROP INDEX IF EXISTS "email_logs_registration_trigger_active_key";
--> statement-breakpoint
ALTER INDEX IF EXISTS "email_logs_registration_trigger_active_key_rebuild"
  RENAME TO "email_logs_registration_trigger_active_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_template_recipient_trigger_active_key_rebuild"
  ON "email_logs" ("template_id", "recipient_email", "trigger")
  WHERE "template_id" IS NOT NULL
    AND "trigger" IS NOT NULL
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED')
    AND "queued_at" >= TIMESTAMP '2026-05-29 00:03:03'
    AND "trigger" <> 'CERTIFICATE_SENT';
--> statement-breakpoint
DROP INDEX IF EXISTS "email_logs_template_recipient_trigger_active_key";
--> statement-breakpoint
ALTER INDEX IF EXISTS "email_logs_template_recipient_trigger_active_key_rebuild"
  RENAME TO "email_logs_template_recipient_trigger_active_key";
