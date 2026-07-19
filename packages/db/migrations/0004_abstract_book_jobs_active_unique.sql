-- Hand-written, same convention as 0001_raw_indexes.sql (not tracked by
-- drizzle-kit / meta/_journal.json).
--
-- L1 fix: server-side guard against duplicate abstract-book jobs. Without
-- this, enqueueAbstractBookJob() only checked config existence + zero
-- unfinished abstracts, so two admins/tabs (or one double-click inside the
-- client's 5s poll window) could enqueue two concurrent PENDING/RUNNING jobs
-- for the same event. Application code pre-checks for an existing
-- PENDING/RUNNING job in-txn (see enqueueAbstractBookJob), and this index is
-- the authoritative backstop for the remaining race window.
CREATE UNIQUE INDEX IF NOT EXISTS "abstract_book_jobs_event_id_active_key"
  ON "abstract_book_jobs" ("event_id")
  WHERE "status" IN ('PENDING', 'RUNNING');
