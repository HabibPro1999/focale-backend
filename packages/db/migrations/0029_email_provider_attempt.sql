-- migrate: transaction per-statement
-- migrate: idempotent
-- 3.6: the provider-attempt marker. The email worker stamps
-- provider_attempted_at (and which provider) in the lease-guarded UPDATE right
-- before it calls the provider; a claim clears it. Lease recovery reads it: an
-- expired lease whose marker is set may already have been sent, so it becomes
-- UNCERTAIN (SendGrid) or is retried under the same idempotency key (Resend)
-- instead of being sent again blind.
-- The (template_id, queued_at) index backs the template branch of the event
-- email-log list (newest first per template).
-- One statement per transaction: CockroachDB must commit each schema change
-- before a later statement relies on it.
ALTER TABLE "email_logs" ADD COLUMN IF NOT EXISTS "provider_attempted_at" timestamp(3);
--> statement-breakpoint
ALTER TABLE "email_logs" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_logs_template_id_queued_at_idx" ON "email_logs" ("template_id", "queued_at");
