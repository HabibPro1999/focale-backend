-- Add worker lease and retry metadata for DB-backed background jobs.
-- All changes are additive and retain existing statuses/columns.

-- Email queue metadata
ALTER TABLE "email_logs" ADD COLUMN "attempt_count" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "email_logs" ADD COLUMN "last_attempt_at" TIMESTAMP(3);
ALTER TABLE "email_logs" ADD COLUMN "next_attempt_at" TIMESTAMP(3);
ALTER TABLE "email_logs" ADD COLUMN "locked_at" TIMESTAMP(3);
ALTER TABLE "email_logs" ADD COLUMN "locked_until" TIMESTAMP(3);
ALTER TABLE "email_logs" ADD COLUMN "locked_by" STRING;

-- Preserve retry visibility for existing rows. Existing SENDING rows have already
-- consumed an attempt, so count the in-flight send as retry_count + 1.
UPDATE "email_logs"
SET "attempt_count" = CASE
  WHEN "status" = 'SENDING' THEN greatest("retry_count" + 1, 1)
  ELSE greatest("retry_count", 0)
END;

-- Preserve existing queued retry delays. retry_count 0 stays immediately due.
UPDATE "email_logs"
SET "next_attempt_at" = CASE
  WHEN "retry_count" <= 0 THEN NULL
  WHEN "retry_count" = 1 THEN "updated_at" + INTERVAL '1 minute'
  WHEN "retry_count" = 2 THEN "updated_at" + INTERVAL '5 minutes'
  ELSE "updated_at" + INTERVAL '15 minutes'
END
WHERE "status" = 'QUEUED';

-- Avoid immediate duplicate sends during rollout; new workers will recover these
-- rows only after the conservative lease expires.
UPDATE "email_logs"
SET
  "locked_at" = "updated_at",
  "locked_until" = "updated_at" + INTERVAL '10 minutes',
  "locked_by" = 'migration-unknown',
  "last_attempt_at" = COALESCE("last_attempt_at", "updated_at")
WHERE "status" = 'SENDING';

CREATE INDEX "email_logs_status_next_attempt_at_queued_at_idx" ON "email_logs"("status", "next_attempt_at", "queued_at");
CREATE INDEX "email_logs_status_locked_until_idx" ON "email_logs"("status", "locked_until");
CREATE INDEX "email_logs_locked_by_idx" ON "email_logs"("locked_by");

-- Abstract Book job metadata
ALTER TABLE "abstract_book_jobs" ADD COLUMN "attempt_count" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "abstract_book_jobs" ADD COLUMN "max_attempts" INT4 NOT NULL DEFAULT 3;
ALTER TABLE "abstract_book_jobs" ADD COLUMN "last_attempt_at" TIMESTAMP(3);
ALTER TABLE "abstract_book_jobs" ADD COLUMN "next_attempt_at" TIMESTAMP(3);
ALTER TABLE "abstract_book_jobs" ADD COLUMN "locked_at" TIMESTAMP(3);
ALTER TABLE "abstract_book_jobs" ADD COLUMN "locked_until" TIMESTAMP(3);
ALTER TABLE "abstract_book_jobs" ADD COLUMN "locked_by" STRING;

UPDATE "abstract_book_jobs"
SET
  "attempt_count" = CASE WHEN "status" = 'RUNNING' THEN 1 ELSE 0 END,
  "locked_at" = CASE WHEN "status" = 'RUNNING' THEN COALESCE("started_at", "updated_at") ELSE "locked_at" END,
  "locked_until" = CASE WHEN "status" = 'RUNNING' THEN COALESCE("started_at", "updated_at") + INTERVAL '1 hour' ELSE "locked_until" END,
  "locked_by" = CASE WHEN "status" = 'RUNNING' THEN 'migration-unknown' ELSE "locked_by" END,
  "last_attempt_at" = CASE WHEN "status" = 'RUNNING' THEN COALESCE("started_at", "updated_at") ELSE "last_attempt_at" END;

CREATE INDEX "abstract_book_jobs_status_next_attempt_at_created_at_idx" ON "abstract_book_jobs"("status", "next_attempt_at", "created_at");
CREATE INDEX "abstract_book_jobs_status_locked_until_idx" ON "abstract_book_jobs"("status", "locked_until");
CREATE INDEX "abstract_book_jobs_locked_by_idx" ON "abstract_book_jobs"("locked_by");
