-- migrate: transaction per-statement
-- migrate: idempotent
-- Networking full-event sync state (plan 4.8). Re-projecting every
-- registration of an event runs in the worker as a chain of
-- `networking.event.sync` outbox rows, one chunk of registrations each. The
-- run's progress lives on the event's config row: sync_run_id names the
-- current run (a new request supersedes it), sync_cursor is the last
-- registration id synced, the counters report progress, sync_error the last
-- chunk failure (the outbox retries it). A NULL sync_status means no sync has
-- been requested since this migration.
-- One statement per transaction: CockroachDB must commit each schema change
-- before a later statement relies on it.
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_run_id text;
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_status text;
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_cursor text;
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_total integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_processed integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_created integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_updated integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_failed integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_requested_at TIMESTAMPTZ(3);
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_finished_at TIMESTAMPTZ(3);
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS sync_error text;
