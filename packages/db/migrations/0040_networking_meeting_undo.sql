-- migrate: transaction per-file
-- migrate: idempotent
ALTER TABLE networking_meetings ADD COLUMN IF NOT EXISTS cancellation_state JSONB;
