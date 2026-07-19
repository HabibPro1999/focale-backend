-- Hand-written. NOT generated or tracked by drizzle-kit (not in meta/_journal.json,
-- same rationale as 0001_raw_indexes.sql). Must be applied after 0001_raw_indexes.sql.
--
-- H6: per-outbox-delivery idempotency for abstract emails. queueAbstractEmail
-- stamps every row it creates with the outbox event id that produced it (or,
-- for the requeue-skipped-abstract-emails recovery script, a key derived from
-- the original email_logs id). A redelivered outbox event (at-least-once:
-- worker crash between handler success and markOutboxProcessed) re-runs the
-- handler with the SAME id, so the second insert conflicts on this partial
-- unique index instead of creating a duplicate row. A genuinely new outbox
-- event (legit re-trigger, e.g. a decision re-sent after reopen) gets a new
-- id and still sends. Scoped to active statuses, mirroring the existing
-- per-trigger dedupe indexes above.

ALTER TABLE "email_logs" ADD COLUMN IF NOT EXISTS "dedupe_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_dedupe_key_active_key"
  ON "email_logs" ("dedupe_key")
  WHERE "dedupe_key" IS NOT NULL
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED');
