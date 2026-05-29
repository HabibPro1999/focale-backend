DROP INDEX IF EXISTS "email_logs_registration_trigger_active_key";

-- Backfill-safe uniqueness: preserve existing duplicate email history and
-- enforce the stricter trigger dedupe only for rows queued after this rollout.
CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_registration_trigger_active_key"
  ON "email_logs" ("registration_id", "trigger")
  WHERE "registration_id" IS NOT NULL
    AND "trigger" IS NOT NULL
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED')
    AND "queued_at" >= TIMESTAMP '2026-05-29 00:03:03';

CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_template_recipient_trigger_active_key"
  ON "email_logs" ("template_id", "recipient_email", "trigger")
  WHERE "template_id" IS NOT NULL
    AND "trigger" IS NOT NULL
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED')
    AND "queued_at" >= TIMESTAMP '2026-05-29 00:03:03';
