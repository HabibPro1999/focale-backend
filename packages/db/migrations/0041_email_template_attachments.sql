-- migrate: transaction per-file
-- migrate: idempotent
-- What each email from a template attaches, built at send time (first kind:
-- the registrant's check-in QR code). Existing templates attach nothing.
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
