-- migrate: transaction per-statement
-- migrate: idempotent
-- migrate: deferrable
-- migrate: defer-unless "SELECT NOT EXISTS (SELECT 1 FROM registrations WHERE NULLIF(upper(trim(sponsorship_code)), '') IS NOT NULL GROUP BY event_id, NULLIF(upper(trim(sponsorship_code)), '') HAVING count(*) > 1)"
-- migrate: verify SELECT count(*) = 1 FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND tablename = 'registrations' AND indexname = 'registrations_event_id_sponsorship_code_key'
-- A signup sponsorship code is consumed by one registration (plan 2.7). The
-- create path already locks the code's sponsorship and refuses a code another
-- registration stored; this index is the backstop: one registration per
-- (event, code). A unique violation on it maps to 409
-- SPONSORSHIP_CODE_ALREADY_USED. Nothing uses ON CONFLICT against it.
--
-- Codes stored before 2.7 kept the registrant's raw input, so they are
-- normalized first (trimmed, upper-cased, blank -> NULL), as signup now stores
-- them. Normalizing never fails (the plain registrations_sponsorship_code_idx
-- is not unique), but it can turn 'sp-x ' and 'SP-X' into duplicates, and
-- before 2.7 one code could be stored by several registrations. While any
-- (event, normalized code) is stored twice the index cannot be built, so the
-- defer-unless check records this migration as deferred instead of failing
-- the deploy, and later migrations still run. Resolve the business-decision
-- list of the worker script repair-sponsorship-code-usages (several claimants,
-- unknown codes), then run `apply --apply-deferred=0030 --yes`.
--
-- One statement per transaction: CockroachDB must not mix the UPDATE and the
-- schema change in one transaction. A rerun after a crash repeats the no-op
-- UPDATE and creates the index if it is still missing.
UPDATE registrations
   SET sponsorship_code = NULLIF(upper(trim(sponsorship_code)), '')
 WHERE sponsorship_code IS NOT NULL
   AND sponsorship_code IS DISTINCT FROM NULLIF(upper(trim(sponsorship_code)), '');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS registrations_event_id_sponsorship_code_key
  ON registrations (event_id, sponsorship_code)
  WHERE sponsorship_code IS NOT NULL;
