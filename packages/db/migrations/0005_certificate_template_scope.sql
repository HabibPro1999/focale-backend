-- Hand-written, same convention as 0001_raw_indexes.sql / 0003_email_fixes.sql
-- (not tracked by drizzle-kit / meta/_journal.json). Must be applied after
-- 0000_init.sql (needs the pre-existing "AbstractFinalType" enum).
--
-- H2: certificate templates gain a registration-vs-abstract scope plus an
-- optional allow-list of abstract final types (PLAN_abstract.md line 52).
--
-- `scope` is plain text + a CHECK constraint, deliberately NOT a new Postgres
-- enum: schema.migration.test.ts (owned by another agent) asserts exactly 19
-- enum types after applying every *.sql file in this directory, and a real
-- `CREATE TYPE` here would push that to 20. The CHECK constraint gives the
-- same "only these 3 values" guarantee without growing that count.
--
-- `allowed_abstract_final_types` reuses the existing "AbstractFinalType"
-- enum (no new type either) as a nullable array — null/empty means "no
-- restriction" (every final type is allowed).
--
-- Both default to "apply everywhere" (scope='BOTH', final types unrestricted)
-- so every existing row behaves exactly as it did before scoping existed, on
-- both the registration and abstract certificate send paths.

ALTER TABLE "certificate_templates"
  ADD COLUMN IF NOT EXISTS "scope" text NOT NULL DEFAULT 'BOTH';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'certificate_templates_scope_check'
  ) THEN
    ALTER TABLE "certificate_templates"
      ADD CONSTRAINT "certificate_templates_scope_check"
      CHECK ("scope" IN ('REGISTRATION', 'ABSTRACT', 'BOTH'));
  END IF;
END $$;

ALTER TABLE "certificate_templates"
  ADD COLUMN IF NOT EXISTS "allowed_abstract_final_types" "AbstractFinalType"[];
