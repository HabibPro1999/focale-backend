-- migrate: transaction per-file
-- migrate: idempotent
-- No fabricated historic login dates: existing users start with NULL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ(3);
