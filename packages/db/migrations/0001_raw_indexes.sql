-- Hand-written. NOT generated or tracked by drizzle-kit (not in meta/_journal.json).
-- Drizzle's schema builder cannot express partial (WHERE) unique indexes, expression
-- predicates, or GIN/inverted indexes, so these live here and must be applied after
-- 0000_init.sql. Index NAMES are byte-for-byte identical to the legacy CockroachDB
-- migrations because application code (P2002 mapping, dedupe guards) matches on them.
-- Source migrations: 20260426100000, 20260516000000, 20260528000000,
-- 20260512000000, 20260516001000, 20260319000001.

-- One active AUTOMATIC email template per (client, trigger, event) namespace.
CREATE UNIQUE INDEX IF NOT EXISTS "email_template_registration_uniq"
  ON "email_templates" ("client_id", "trigger", "event_id")
  WHERE "abstract_trigger" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "email_template_abstract_uniq"
  ON "email_templates" ("client_id", "abstract_trigger", "event_id")
  WHERE "trigger" IS NULL;

-- One abstract per (event, normalized author email), NULLs excluded.
CREATE UNIQUE INDEX IF NOT EXISTS "abstracts_event_id_author_email_normalized_key"
  ON "abstracts" ("event_id", "author_email_normalized")
  WHERE "author_email_normalized" IS NOT NULL;

-- Only one queued/in-flight registration email per (registration, trigger).
-- Current (post-20260528) predicate: no trigger whitelist, queued_at cutoff guard
-- so pre-rollout duplicate history is not retroactively rejected.
CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_registration_trigger_active_key"
  ON "email_logs" ("registration_id", "trigger")
  WHERE "registration_id" IS NOT NULL
    AND "trigger" IS NOT NULL
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED')
    AND "queued_at" >= TIMESTAMP '2026-05-29 00:03:03';

-- One active submission-ack per (abstract, recipient).
CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_abstract_submission_ack_active_key"
  ON "email_logs" ("abstract_id", "abstract_trigger", "recipient_email")
  WHERE "abstract_id" IS NOT NULL
    AND "abstract_trigger" = 'ABSTRACT_SUBMISSION_ACK'
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED');

-- One active manual/template email per (template, recipient, trigger).
CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_template_recipient_trigger_active_key"
  ON "email_logs" ("template_id", "recipient_email", "trigger")
  WHERE "template_id" IS NOT NULL
    AND "trigger" IS NOT NULL
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED')
    AND "queued_at" >= TIMESTAMP '2026-05-29 00:03:03';

-- Unique numeric code portion per event, NULLs excluded.
CREATE UNIQUE INDEX IF NOT EXISTS "abstracts_event_id_code_number_key"
  ON "abstracts" ("event_id", "code_number")
  WHERE "code_number" IS NOT NULL;

-- Outbox dedupe: unique non-null dedupe_key.
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_dedupe_key_key"
  ON "outbox_events" ("dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;

-- Array containment acceleration for registrations.access_type_ids.
-- CRDB prod uses `CREATE INVERTED INDEX`; Postgres uses `USING GIN`. CockroachDB
-- also accepts `CREATE INDEX ... USING GIN` as an alias for INVERTED INDEX, so this
-- single statement is valid on both engines.
CREATE INDEX IF NOT EXISTS "registrations_access_type_ids_inverted_idx"
  ON "registrations" USING GIN ("access_type_ids");
