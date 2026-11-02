-- migrate: transaction per-file
-- migrate: idempotent
ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ(3);
