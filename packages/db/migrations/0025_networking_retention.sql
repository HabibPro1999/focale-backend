-- migrate: transaction per-statement
-- migrate: idempotent
-- Networking retention (plan 4.4). Purging an event past its retention is
-- batched and resumable: purge_started_at is set when the purge begins (the
-- same statement disables the config), purged_at when every networking row of
-- the event is gone. erased_at marks a withdrawn profile reduced to a tombstone
-- once NETWORKING_WITHDRAWAL_ERASE_DAYS have passed, so registration sync never
-- recreates it.
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS purge_started_at TIMESTAMPTZ(3);
--> statement-breakpoint
ALTER TABLE networking_configs ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ(3);
--> statement-breakpoint
ALTER TABLE networking_profiles ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ(3);
--> statement-breakpoint
-- The erasure scan reads withdrawn profiles by withdrawal time; withdrawals are rare,
-- so the partial index stays small.
CREATE INDEX IF NOT EXISTS networking_profiles_withdrawn_idx ON networking_profiles (withdrawn_at)
 WHERE withdrawn_at IS NOT NULL;
