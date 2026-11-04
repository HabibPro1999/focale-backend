-- migrate: transaction per-statement
-- migrate: idempotent
-- migrate: verify SELECT (SELECT count(*) = 1 FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND indexname = 'email_logs_template_recipient_trigger_active_key' AND indexdef LIKE '%registration_id IS NULL%') AND (SELECT count(*) = 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.email_logs'::regclass AND conname = 'email_logs_registration_id_registrations_id_fk' AND confdeltype = 'c') AND (SELECT count(*) = 0 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.email_logs'::regclass AND conname = 'email_logs_registration_id_fkey')
-- A person whose registration an admin deleted got no pre-registration email
-- when they registered again with the same address. The deleted registration's
-- REGISTRATION_CREATED log stayed (registration_id SET NULL) with status SENT or
-- DELIVERED, and the template + recipient + trigger index refused the new
-- registration's log; createEmailLog reported the conflict as a duplicate and
-- the outbox event was SKIPPED. The same refusal hit one address registered on
-- two forms of one event.
--
-- 1. The template + recipient + trigger index now covers only logs with no
--    registration (sponsorship and other recipient-only sends). A log tied to a
--    registration is deduplicated per registration by
--    email_logs_registration_trigger_active_key. The new predicate is a subset
--    of the old one, so the build cannot meet duplicates. Rebuilt under a
--    temporary name, the old one dropped, the new one renamed (as 0024), so
--    createEmailLog keeps matching the same name.
-- 2. Deleting a registration now deletes its email logs (ON DELETE CASCADE
--    instead of SET NULL): a deleted registration leaves no email trace.
--    Production keeps Prisma's constraint name (_fkey); a fresh database has
--    Drizzle's (_fk). Both are dropped, then the Drizzle name is added.
--
-- Existing rows are not changed: logs already orphaned by earlier deletes stay,
-- and the narrower index no longer lets them block a new registration.
-- Nothing uses ON CONFLICT against this index (createEmailLog catches 23505).
CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_template_recipient_trigger_active_key_rebuild"
  ON "email_logs" ("template_id", "recipient_email", "trigger")
  WHERE "template_id" IS NOT NULL
    AND "trigger" IS NOT NULL
    AND "registration_id" IS NULL
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED')
    AND "queued_at" >= TIMESTAMP '2026-05-29 00:03:03'
    AND "trigger" <> 'CERTIFICATE_SENT';
--> statement-breakpoint
DROP INDEX IF EXISTS "email_logs_template_recipient_trigger_active_key";
--> statement-breakpoint
ALTER INDEX IF EXISTS "email_logs_template_recipient_trigger_active_key_rebuild"
  RENAME TO "email_logs_template_recipient_trigger_active_key";
--> statement-breakpoint
ALTER TABLE "email_logs" DROP CONSTRAINT IF EXISTS "email_logs_registration_id_fkey";
--> statement-breakpoint
ALTER TABLE "email_logs" DROP CONSTRAINT IF EXISTS "email_logs_registration_id_registrations_id_fk";
--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_registration_id_registrations_id_fk"
  FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
