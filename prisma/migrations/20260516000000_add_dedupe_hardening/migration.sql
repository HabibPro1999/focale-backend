-- DB-backed dedupe hardening for races that are guarded in application code.
-- Partial unique indexes are used for nullable columns and retryable email rows.

UPDATE "abstracts"
SET "author_email_normalized" = lower(trim("author_email"))
WHERE "author_email_normalized" IS NULL
  AND "author_email" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "abstracts_event_id_author_email_normalized_key"
  ON "abstracts" ("event_id", "author_email_normalized")
  WHERE "author_email_normalized" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_registration_trigger_active_key"
  ON "email_logs" ("registration_id", "trigger")
  WHERE "registration_id" IS NOT NULL
    AND "trigger" IN ('REGISTRATION_CREATED', 'PAYMENT_PROOF_SUBMITTED', 'PAYMENT_CONFIRMED')
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED');

CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_abstract_submission_ack_active_key"
  ON "email_logs" ("abstract_id", "abstract_trigger", "recipient_email")
  WHERE "abstract_id" IS NOT NULL
    AND "abstract_trigger" = 'ABSTRACT_SUBMISSION_ACK'
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED');
