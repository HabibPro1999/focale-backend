-- Migration: harden_edit_token
-- Replaces the plaintext editToken column with a SHA-256 hash column.
-- Option A rollout: all existing tokens are invalidated on deploy.
-- Registrants needing access must re-request via the existing token-request flow.
-- Expiry is derived dynamically at verify-time via event.startDate — no stored expiry column.

ALTER TABLE "registrations"
  DROP COLUMN IF EXISTS "edit_token",
  ADD COLUMN "edit_token_hash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "registrations_edit_token_hash_key"
  ON "registrations"("edit_token_hash");
