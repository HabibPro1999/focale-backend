-- Add idempotency_key column to email_logs for dedup of triggered emails
-- Null for manual/bulk/sponsor sends; set to "{registrationId}:{trigger}" for automatic sends.
-- The unique constraint is the authoritative dedup gate (P2002 on conflict).

ALTER TABLE "email_logs" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "email_logs_idempotency_key_key" ON "email_logs"("idempotency_key");
