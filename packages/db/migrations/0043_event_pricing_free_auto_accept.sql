-- migrate: transaction per-statement
-- migrate: idempotent
-- Free events and auto-accepted public registrations. Expand-only: two
-- booleans defaulting to false, so every existing event keeps its pricing and
-- its PENDING-first signup. `auto_accept` is only honoured with `is_free`
-- (the API enforces it). One column per statement: the catalog probes (adopt,
-- verify --schema) read one added column per ALTER, and CockroachDB keeps
-- each schema change in its own short transaction.
ALTER TABLE event_pricing ADD COLUMN IF NOT EXISTS is_free BOOL NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE event_pricing ADD COLUMN IF NOT EXISTS auto_accept BOOL NOT NULL DEFAULT false;
