-- Fix condition_logic default casing on production.
-- Production stored the default as lowercase 'and'. Standardize to uppercase 'AND'
-- to match the schema. No row data is changed — SET DEFAULT only affects future
-- inserts, not existing rows. Safe to re-run (idempotent).
ALTER TABLE "event_access" ALTER COLUMN "condition_logic" SET DEFAULT 'AND';

-- NOTE: companion_price is bigint on production vs INT4 in schema.
-- Functionally identical for a price column (all values fit in INT4 range).
-- ALTER COLUMN TYPE is not supported via this path on CockroachDB.
-- Leaving as bigint — Prisma reads both types as number with no behavioral difference.
