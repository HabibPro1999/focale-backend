-- migrate: transaction none
-- migrate: idempotent
-- migrate: verify SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'EmailStatus' AND e.enumlabel = 'UNCERTAIN')
-- 3.6: an email whose provider call may have gone through but was never
-- confirmed (a timeout or connection reset after the request was sent, or a
-- worker that died after calling the provider) becomes UNCERTAIN instead of
-- being sent again. A provider webhook moves it forward; an admin can resend it.
-- No transaction: PostgreSQL cannot use a new enum value in the transaction
-- that adds it, and CockroachDB runs enum changes as their own schema change.
ALTER TYPE "EmailStatus" ADD VALUE IF NOT EXISTS 'UNCERTAIN';
